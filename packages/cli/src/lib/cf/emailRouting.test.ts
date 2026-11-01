import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import {
  createEmailRoutingRule,
  deleteEmailRoutingRule,
  enableEmailRouting,
  getEmailRoutingCatchAll,
  getEmailRoutingRule,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  ruleAddress,
  ruleWorker,
  updateEmailRoutingCatchAll,
  updateEmailRoutingRule,
  type EmailRoutingRuleBody,
} from "./emailRouting";
import { FakeCf } from "./fakeCf";

const WORKER = "every-acme-inbox";

function literal(address: string, worker = WORKER): EmailRoutingRuleBody {
  return {
    name: `everyapp:${worker}`,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [worker] }],
  };
}

function accountWithWorker(): FakeCloudflare {
  const account = new FakeCloudflare();
  account.workers.set(WORKER, { versions: ["v1"], config: {}, secrets: {} });
  return account;
}

describe("Email Routing through cf", () => {
  it("reads a zone's settings and turns routing on for a domain by name", async () => {
    const account = accountWithWorker();
    await expect(getEmailRoutingSettings(account.cf, "zone-1")).resolves.toMatchObject({
      enabled: false,
    });

    await enableEmailRouting(account.cf, "zone-1", "example.com");
    await enableEmailRouting(account.cf, "zone-1", "mail.example.com");

    await expect(getEmailRoutingSettings(account.cf, "zone-1")).resolves.toMatchObject({
      enabled: true,
      status: "ready",
    });
    expect(
      account.dnsRecords
        .filter((record) => record.name === "mail.example.com")
        .map((record) => record.content),
    ).toEqual([
      "route1.mx.cloudflare.net",
      "route2.mx.cloudflare.net",
      "route3.mx.cloudflare.net",
    ]);
    expect(account.cf.calls.map((call) => call.args)).toEqual([
      ["email-routing", "settings", "get", "-z", "zone-1"],
      ["email-routing", "enable", "-z", "zone-1", "--name", "example.com"],
      ["email-routing", "enable", "-z", "zone-1", "--name", "mail.example.com"],
      ["email-routing", "settings", "get", "-z", "zone-1"],
    ]);
  });

  it("creates, reads, updates and deletes a rule, its body in a file", async () => {
    const account = accountWithWorker();
    const id = await createEmailRoutingRule(account.cf, "zone-1", literal("support@example.com"));
    const create = account.cf.calls.at(-1)!;
    expect(create.args).toEqual([
      "email-routing",
      "rules",
      "create",
      "-z",
      "zone-1",
      "--body",
      "@/fake-cf-files/rule.json",
    ]);
    expect(JSON.parse(create.files["rule.json"]!)).toEqual(literal("support@example.com"));

    const rule = (await getEmailRoutingRule(account.cf, "zone-1", id))!;
    expect(rule).toMatchObject({ id, name: `everyapp:${WORKER}`, enabled: true });
    expect(ruleAddress(rule)).toBe("support@example.com");
    expect(ruleWorker(rule)).toBe(WORKER);

    await updateEmailRoutingRule(account.cf, "zone-1", id, {
      ...literal("support@example.com"),
      enabled: false,
    });
    await expect(getEmailRoutingRule(account.cf, "zone-1", id)).resolves.toMatchObject({
      enabled: false,
    });

    await expect(deleteEmailRoutingRule(account.cf, "zone-1", id)).resolves.toBe(true);
    expect(account.cf.calls.at(-1)!.args).toContain("--force");
    // Gone already: said, not thrown.
    await expect(deleteEmailRoutingRule(account.cf, "zone-1", id)).resolves.toBe(false);
    await expect(getEmailRoutingRule(account.cf, "zone-1", id)).resolves.toBeNull();
  });

  it("lists every page of a zone's rules", async () => {
    const account = accountWithWorker();
    for (let index = 0; index < 60; index += 1) {
      await createEmailRoutingRule(account.cf, "zone-1", literal(`a${index}@example.com`));
    }
    const rules = await listEmailRoutingRules(account.cf, "zone-1");
    expect(rules).toHaveLength(60);
    expect(
      account.cf.calls
        .filter((call) => call.args[2] === "list-account")
        .map((call) => call.args.slice(5)),
    ).toEqual([
      ["--per-page", "50", "--page", "1"],
      ["--per-page", "50", "--page", "2"],
    ]);
  });

  it("stops listing when the API repeats a page", async () => {
    const rule = { id: "r1", name: "x", enabled: true, matchers: [], actions: [] };
    const cf = new FakeCf().on(["email-routing", "rules", "list-account"], {
      stdout: JSON.stringify(Array.from({ length: 50 }, () => rule)),
    });
    await expect(listEmailRoutingRules(cf, "zone-1")).resolves.toHaveLength(1);
    expect(cf.calls).toHaveLength(2);
  });

  it("reads rules by their older tag too", async () => {
    const cf = new FakeCf().on(["email-routing", "rules", "get"], {
      stdout: JSON.stringify({ tag: "t1", matchers: [{ type: "all" }], actions: [{ type: "drop" }] }),
    });
    await expect(getEmailRoutingRule(cf, "zone-1", "t1")).resolves.toEqual({
      id: "t1",
      name: null,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
  });

  it("points the zone's catch-all at a Worker", async () => {
    const account = accountWithWorker();
    await expect(getEmailRoutingCatchAll(account.cf, "zone-1")).resolves.toMatchObject({
      enabled: true,
      actions: [{ type: "drop" }],
    });
    const body: EmailRoutingRuleBody = {
      name: `everyapp:${WORKER}`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [WORKER] }],
    };
    await updateEmailRoutingCatchAll(account.cf, "zone-1", body);
    const update = account.cf.calls.at(-1)!;
    expect(update.args).toEqual([
      "email-routing",
      "rules",
      "catch-all",
      "update",
      "-z",
      "zone-1",
      "--body",
      "@/fake-cf-files/catch-all.json",
    ]);
    expect(ruleWorker(await getEmailRoutingCatchAll(account.cf, "zone-1"))).toBe(WORKER);
  });

  it("can't send mail to a Worker that doesn't exist", async () => {
    const account = new FakeCloudflare();
    await expect(
      createEmailRoutingRule(account.cf, "zone-1", literal("support@example.com")),
    ).rejects.toThrow(/does not exist/);
  });
});
