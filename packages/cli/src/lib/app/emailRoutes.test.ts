import { beforeEach, describe, expect, it } from "vitest";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import {
  applyEmailRoutes,
  emailRouteProblems,
  planEmailRoutes,
  removeEmailRoutes,
  routeRuleName,
} from "./emailRoutes";
import { readOwnedResources, readResourcesOfKind, recordOwnedResource } from "./ownership";

const WORKER = "every-acme-inbox";
const OTHER = "every-acme-helpdesk";

let account: FakeCloudflare;
let db: D1Database;

beforeEach(() => {
  account = new FakeCloudflare();
  account.zones.push({ id: "zone-2", name: "other.org", status: "active" });
  db = cfD1Database(account.cf, account.createDatabase("every-app-gateway").uuid);
  for (const name of [WORKER, OTHER]) {
    account.workers.set(name, { versions: ["v1"], config: {}, secrets: {} });
  }
});

/** Email Routing on for the zone's apex (and its subdomains' MX records). */
function routeMail(zoneId: string, ...domains: string[]) {
  const zone = account.zones.find((candidate) => candidate.id === zoneId)!;
  account.emailRoutingOf(zoneId).enabled = true;
  for (const domain of domains.length ? domains : [zone.name]) {
    account.dnsRecords.push({ zoneId, name: domain, type: "MX", content: "route1.mx.cloudflare.net" });
  }
}

function plan(inbound: string[] | undefined, extra: Partial<Parameters<typeof planEmailRoutes>[0]> = {}) {
  return planEmailRoutes({
    cf: account.cf,
    gatewayDb: db,
    accountId: ACCOUNT_ID,
    workerName: WORKER,
    addresses: inbound ?? [],
    interactive: false,
    ...extra,
  });
}

async function deployRoutes(inbound: string[] | undefined) {
  const planned = await plan(inbound);
  return planned ? applyEmailRoutes({ cf: account.cf, gatewayDb: db, plan: planned }) : null;
}

const routes = async (worker = WORKER) =>
  (await readOwnedResources(db, worker)).filter((resource) => resource.kind === "email-route");

describe("planEmailRoutes", () => {
  it("has nothing to do for an app that never received mail", async () => {
    await expect(plan(undefined)).resolves.toBeNull();
    await expect(plan([])).resolves.toBeNull();
    expect(account.cf.calls.filter((call) => call.args[0] === "email-routing")).toEqual([]);
  });

  it("refuses an address on a domain no zone in the account holds", async () => {
    await expect(plan(["support@unknown.net"])).rejects.toMatchObject({
      code: "EMAIL_ZONE_NOT_FOUND",
      message: expect.stringContaining("unknown.net isn't on a zone"),
    });
  });

  it("refuses a catch-all on a subdomain: Email Routing has them on a zone's apex only", async () => {
    routeMail("zone-1");
    await expect(plan(["*@mail.example.com"])).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_NOT_APEX",
      message: expect.stringContaining("support@mail.example.com"),
    });
  });

  it("refuses an address another app's deploy recorded", async () => {
    routeMail("zone-1");
    await recordOwnedResource(db, OTHER, {
      kind: "email-route",
      binding: "support@example.com",
      name: "support@example.com",
      resourceId: "zone-1/rule-x",
    });
    await expect(plan(["support@example.com"])).rejects.toMatchObject({
      code: "EMAIL_ADDRESS_TAKEN",
      message: expect.stringContaining(OTHER),
    });
  });

  it("refuses an address a rule it didn't make delivers elsewhere", async () => {
    routeMail("zone-1");
    account.emailRoutingOf("zone-1").rules.set("r-1", {
      id: "r-1",
      name: "Ben's inbox",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@example.com" }],
      actions: [{ type: "forward", value: ["ben@gmail.com"] }],
    });
    await expect(plan(["support@example.com"])).rejects.toMatchObject({
      code: "EMAIL_ADDRESS_TAKEN",
      message: expect.stringContaining('"Ben\'s inbox" in example.com sends it to ben@gmail.com'),
    });
  });

  it("refuses a catch-all that already sends mail somewhere, and takes one that drops it or is off", async () => {
    routeMail("zone-1");
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = {
      ...routing.catchAll,
      name: "to the team",
      actions: [{ type: "forward", value: ["team@gmail.com"] }],
    };
    await expect(plan(["*@example.com"])).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_TAKEN",
      message: expect.stringContaining("example.com's catch-all already sends mail to team@gmail.com"),
    });

    routing.catchAll = { ...routing.catchAll, enabled: false };
    await expect(plan(["*@example.com"])).resolves.toMatchObject({
      routes: [{ address: "*@example.com", existing: null }],
    });
  });

  it("stops unattended when routing is off for a domain, naming the flag and the manual commands", async () => {
    const error = await plan(["*@example.com", "support@mail.example.com"]).catch((e) => e);
    expect(error).toMatchObject({
      code: "EMAIL_ROUTING_DISABLED",
      authorize: true,
      rerun: expect.stringContaining("--enable-email-routing"),
      data: {
        domains: ["example.com", "mail.example.com"],
        commands: [
          "npx cf email-routing enable -z example.com --name example.com",
          "npx cf email-routing enable -z example.com --name mail.example.com",
        ],
      },
    });
    // Asked for nothing it could not answer, and changed nothing.
    expect(account.emailRoutingOf("zone-1").enabled).toBe(false);
  });

  it("asks at a terminal, and stops when the person says no", async () => {
    const questions: string[] = [];
    const ask = (answer: boolean) => async (question: string) => {
      questions.push(question);
      return answer;
    };
    await expect(
      plan(["support@example.com"], { interactive: true, confirm: ask(false) }),
    ).rejects.toMatchObject({ code: "EMAIL_ROUTING_DISABLED" });
    expect(questions).toEqual([
      "Turn on Email Routing for example.com? Cloudflare adds and locks its MX and SPF records, so mail for it goes to Cloudflare from then on.",
    ]);

    const agreed = await plan(["support@example.com"], { interactive: true, confirm: ask(true) });
    expect(agreed?.enable).toEqual([{ zone: { id: "zone-1", name: "example.com" }, domain: "example.com" }]);
  });

  it("tells a subdomain that routes mail by its MX records", async () => {
    account.emailRoutingOf("zone-1").enabled = true;
    const missing = await plan(["support@mail.example.com"], { enableRouting: true });
    expect(missing?.enable.map((entry) => entry.domain)).toEqual(["mail.example.com"]);

    routeMail("zone-1", "mail.example.com");
    const routed = await plan(["support@mail.example.com"]);
    expect(routed?.enable).toEqual([]);
  });
});

describe("applyEmailRoutes", () => {
  it("turns routing on where agreed, makes a rule per address and the catch-all, and records each", async () => {
    const planned = (await plan(["*@example.com", "support@mail.example.com", "hi@other.org"], {
      enableRouting: true,
    }))!;
    expect(planned.enable.map((entry) => entry.domain)).toEqual([
      "example.com",
      "other.org",
      "mail.example.com",
    ]);
    const { routed, changed } = await applyEmailRoutes({ cf: account.cf, gatewayDb: db, plan: planned });

    expect(routed).toEqual(["*@example.com", "support@mail.example.com", "hi@other.org"]);
    expect(changed).toBe(true);
    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
    expect(account.emailRoutingOf("zone-2").enabled).toBe(true);
    const [support] = account.emailRulesFor("zone-1", "support@mail.example.com");
    const [hi] = account.emailRulesFor("zone-2", "hi@other.org");
    expect(support).toMatchObject({
      name: routeRuleName(WORKER),
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@mail.example.com" }],
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(account.emailRoutingOf("zone-1").catchAll).toMatchObject({
      name: routeRuleName(WORKER),
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(await routes()).toEqual([
      expect.objectContaining({ binding: "*@example.com", resourceId: "catch_all:zone-1" }),
      expect.objectContaining({ binding: "hi@other.org", resourceId: `zone-2/${hi!.id}` }),
      expect.objectContaining({
        binding: "support@mail.example.com",
        name: "support@mail.example.com",
        resourceId: `zone-1/${support!.id}`,
      }),
    ]);
  });

  it("changes nothing on a redeploy that asks for the same routes", async () => {
    routeMail("zone-1", "example.com", "mail.example.com");
    await deployRoutes(["*@example.com", "support@mail.example.com"]);
    const writes = () =>
      account.cf.calls.filter(
        (call) => call.args[0] === "email-routing" && ["create", "update", "delete", "enable"].some((verb) => call.args.includes(verb)),
      ).length;
    const before = writes();
    const again = await deployRoutes(["*@example.com", "support@mail.example.com"]);
    expect(writes()).toBe(before);
    expect(again).toMatchObject({ changed: false });

    // A rule deleted by hand is made again, and the run says it changed something.
    const [support] = account.emailRulesFor("zone-1", "support@mail.example.com");
    account.emailRoutingOf("zone-1").rules.delete(support!.id);
    const repaired = await deployRoutes(["*@example.com", "support@mail.example.com"]);
    expect(repaired).toMatchObject({ changed: true });
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
  });

  it("adopts the catch-all the manual step pointed at the Worker, and renames it", async () => {
    routeMail("zone-1");
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = {
      ...routing.catchAll,
      name: "",
      actions: [{ type: "worker", value: [WORKER] }],
    };
    await deployRoutes(["*@example.com"]);
    expect(routing.catchAll.name).toBe(routeRuleName(WORKER));
    expect(await routes()).toEqual([
      expect.objectContaining({ binding: "*@example.com", resourceId: "catch_all:zone-1" }),
    ]);
  });

  it("adopts a rule a create made before its id was recorded, instead of making a second", async () => {
    routeMail("zone-1");
    // The claim, then the create, then the run stopped.
    await recordOwnedResource(db, WORKER, {
      kind: "email-route",
      binding: "support@example.com",
      name: "support@example.com",
      resourceId: null,
    });
    account.emailRoutingOf("zone-1").rules.set("lost", {
      id: "lost",
      name: routeRuleName(WORKER),
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@example.com" }],
      actions: [{ type: "worker", value: [WORKER] }],
    });

    await deployRoutes(["support@example.com"]);

    expect(account.emailRulesFor("zone-1", "support@example.com")).toHaveLength(1);
    expect(account.cf.calls.some((call) => call.args[2] === "create")).toBe(false);
    expect(await routes()).toEqual([
      expect.objectContaining({ binding: "support@example.com", resourceId: "zone-1/lost" }),
    ]);
  });

  it("deletes a dropped address's rule, and sets a dropped catch-all back to dropping mail", async () => {
    routeMail("zone-1");
    await deployRoutes(["*@example.com", "support@example.com"]);

    await deployRoutes(["help@example.com"]);

    expect(account.emailRulesFor("zone-1", "support@example.com")).toEqual([]);
    expect(account.emailRulesFor("zone-1", "help@example.com")).toHaveLength(1);
    expect(account.emailRoutingOf("zone-1").catchAll).toMatchObject({
      enabled: false,
      actions: [{ type: "drop" }],
    });
    expect((await routes()).map((route) => route.binding)).toEqual(["help@example.com"]);

    // No inbound left: every route goes.
    await deployRoutes(undefined);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect(await routes()).toEqual([]);
    await expect(plan(undefined)).resolves.toBeNull();
  });

  it("leaves a dropped catch-all alone once someone else changed it", async () => {
    routeMail("zone-1");
    await deployRoutes(["*@example.com"]);
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = { ...routing.catchAll, name: "mine now", actions: [{ type: "forward", value: ["me@x.io"] }] };

    await deployRoutes([]);

    expect(routing.catchAll.actions).toEqual([{ type: "forward", value: ["me@x.io"] }]);
    expect(await routes()).toEqual([]);
  });
});

describe("removeEmailRoutes", () => {
  it("deletes every recorded route, a rule gone already included, and forgets them", async () => {
    routeMail("zone-1");
    await deployRoutes(["*@example.com", "support@example.com", "help@example.com"]);
    const [help] = account.emailRulesFor("zone-1", "help@example.com");
    account.emailRoutingOf("zone-1").rules.delete(help!.id);

    const removed = await removeEmailRoutes({
      cf: account.cf,
      gatewayDb: db,
      accountId: ACCOUNT_ID,
      workerName: WORKER,
      routes: await routes(),
    });

    expect(removed).toEqual([
      "the catch-all of example.com (it drops mail again)",
      "the Email Routing rule for support@example.com",
    ]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect(account.emailRoutingOf("zone-1").catchAll.actions).toEqual([{ type: "drop" }]);
    expect(await routes()).toEqual([]);
  });
});

describe("emailRouteProblems", () => {
  it("names each recorded route that no longer delivers to its app's Worker", async () => {
    routeMail("zone-1", "example.com", "mail.example.com");
    routeMail("zone-2");
    await deployRoutes(["*@example.com", "support@example.com", "help@mail.example.com", "hi@other.org"]);
    const all = () => readResourcesOfKind(db, "email-route");
    await expect(emailRouteProblems(account.cf, await all())).resolves.toEqual([]);

    const [support] = account.emailRulesFor("zone-1", "support@example.com");
    account.emailRoutingOf("zone-1").rules.delete(support!.id);
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = { ...routing.catchAll, enabled: false };
    account.dnsRecords.splice(
      account.dnsRecords.findIndex((record) => record.name === "mail.example.com"),
      1,
    );
    account.emailRoutingOf("zone-2").enabled = false;

    await expect(emailRouteProblems(account.cf, await all())).resolves.toEqual([
      { workerName: WORKER, address: "*@example.com", problem: "the catch-all is off" },
      { workerName: WORKER, address: "help@mail.example.com", problem: "Email Routing is off for mail.example.com" },
      { workerName: WORKER, address: "hi@other.org", problem: "Email Routing is off for other.org" },
      { workerName: WORKER, address: "support@example.com", problem: "its Email Routing rule is gone" },
    ]);
  });
});
