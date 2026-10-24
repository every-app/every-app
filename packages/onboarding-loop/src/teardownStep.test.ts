import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCfApi, createFakeCfFetch, type FakeCfRoute } from "./cf";
import type { ExecCapture } from "./sandbox";
import {
  flattenPlan,
  parseEvents,
  readConfirmFile,
  createRunMarker,
  recordsUnderGateway,
  removeRunMarker,
  runIdTime,
  runTeardownStep,
  TeardownStepError,
  blockingMarkers,
  markerTitle,
} from "./teardownStep";
import type { Account } from "./types";
import type { Sibling } from "./withTestAccount";

const ID = "0123456789abcdef0123456789abcdef";
const account: Account = {
  name: "loop-1",
  accountId: ID,
  zone: "everyapp-loop1.com",
  email: "owner@everyapp-loop1.com",
  token: "fake-token-abcdefghijklmnopqrstuv",
};
const RUN_ID = "2026-10-25T12:00-script-aaa111";
const NOW = Date.parse("2026-10-25T12:05:00Z");

/** `data.plan` as packages/cli's planData() writes it, with one of most kinds. */
const fullPlan = {
  accountId: ID,
  gateway: { databaseId: "db-gw", gatewayHost: "apps.everyapp-loop1.com" },
  counts: {
    access: 3,
    email: 2,
    workflows: 0,
    workers: 2,
    certificates: 1,
    d1: 2,
    kv: 2,
    r2: 0,
    hyperdrive: 0,
    dns: 1,
  },
  total: 13,
  workers: [
    { name: "every-acme-hello", domains: ["hello.apps.everyapp-loop1.com"] },
    { name: "every-app-gateway", domains: ["apps.everyapp-loop1.com"] },
  ],
  workflows: [],
  d1: [
    { name: "every-acme-hello--DB", id: "db-app" },
    { name: "every-app-gateway", id: "db-gw" },
  ],
  kv: [
    { title: "every-acme-hello--KV", id: "kv-app" },
    { title: "every-app-gateway-OAUTH_KV", id: "kv-gw" },
  ],
  r2: [],
  hyperdrive: [],
  access: {
    applications: [
      { id: "app1", name: "Every App gateway" },
      { id: "app2", name: "Every App apps" },
    ],
    policy: { id: "pol1", name: "Every App gateway members" },
  },
  email: [
    {
      zoneId: "z1",
      zoneName: "everyapp-loop1.com",
      rules: [
        {
          id: "rule1",
          address: "hi@everyapp-loop1.com",
          worker: "every-acme-inbox",
        },
      ],
      catchAllWorker: null,
      disable: true,
    },
  ],
  certificates: [
    {
      zoneId: "z1",
      zoneName: "everyapp-loop1.com",
      hostname: "apps.everyapp-loop1.com",
      packId: "pack1",
    },
  ],
  dns: [
    {
      zoneId: "z1",
      zoneName: "everyapp-loop1.com",
      name: "apps.everyapp-loop1.com",
      records: [{ id: "rec1", type: "A", content: "192.0.2.1" }],
    },
  ],
  kept: ["the zone", "the Workers Paid subscription"],
};
const emptyPlan = {
  ...fullPlan,
  counts: {
    ...fullPlan.counts,
    access: 0,
    email: 0,
    workers: 0,
    certificates: 0,
    d1: 0,
    kv: 0,
    dns: 0,
  },
  total: 0,
  workers: [],
  d1: [],
  kv: [],
  access: { applications: [], policy: null },
  email: [],
  certificates: [],
  dns: [],
};

const done = (plan: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    ts: "2026-10-25T12:05:00Z",
    type: "done",
    message: "x",
    data: {
      accountId: ID,
      dryRun: true,
      removed: [],
      kept: [],
      plan,
      ...extra,
    },
  });
const errorEvent = (code: string) =>
  JSON.stringify({
    v: 1,
    ts: "t",
    type: "error",
    code,
    message: `${code} happened`,
    retryable: false,
  });

/** A sibling whose `everyapp` answers come from a queue of stdout lines, in order. */
function fakeSibling(answers: string[][]): Sibling & { calls: string[][] } {
  const calls: string[][] = [];
  const capture = (stdout: string[]): ExecCapture => ({
    result: { exitCode: 0, signal: null, durationMs: 1, killed: false },
    stdout,
    stderr: [],
  });
  return {
    calls,
    handle: { id: "x", name: "loop-sib" },
    checkout: "/work/every-app",
    exec: async (argv) => {
      calls.push(argv);
      return capture([]);
    },
    everyapp: async (args) => {
      calls.push(["pnpm", "everyapp", ...args]);
      return capture(answers.shift() ?? []);
    },
  };
}

const cfWith = (extra: FakeCfRoute[] = [], kv: string[] = []) => {
  const fake = createFakeCfFetch([
    ...extra,
    {
      method: "GET",
      path: /\/storage\/kv\/namespaces$/,
      reply: () => ({
        result: kv.map((title, i) => ({ id: `kv${i}`, title })),
      }),
    },
    {
      method: "GET",
      path: /^\/zones$/,
      reply: () => ({
        result: [{ id: "z1", name: "everyapp-loop1.com", status: "active" }],
      }),
    },
    {
      method: "GET",
      path: /^\/zones\/z1\/dns_records$/,
      reply: () => ({
        result: [
          { id: "mx", type: "MX", name: "everyapp-loop1.com", content: "mx" },
        ],
      }),
    },
  ]);
  return createCfApi({
    token: account.token,
    accountId: ID,
    fetch: fake.fetch,
  });
};

const base = (
  sibling: Sibling,
  overrides: Partial<Parameters<typeof runTeardownStep>[0]> = {},
) => ({
  sibling,
  account,
  runId: RUN_ID,
  cf: cfWith(),
  confirm: async () => ID,
  now: () => NOW,
  sleep: async () => undefined,
  pollMs: 1,
  pollDeadlineMs: 1000,
  ...overrides,
});

describe("teardownStep helpers", () => {
  it("parses only the JSON events out of a run's stdout", () => {
    const events = parseEvents([
      "> everyapp@0.3.0 everyapp",
      "",
      '{"v":1,"ts":"t","type":"step","step":"teardown.check","status":"start"}',
      "not json {",
      done(emptyPlan),
    ]);
    expect(events.map((event) => event.type)).toEqual(["step", "done"]);
  });

  it("flattens data.plan to one item per thing, in deletion order, keeping total and kept", () => {
    const plan = flattenPlan(fullPlan, "2026-10-25T12:05:00Z");
    expect(plan.total).toBe(13);
    expect(plan.accountId).toBe(ID);
    expect(plan.kept).toEqual(["the zone", "the Workers Paid subscription"]);
    expect(plan.items.map((item) => item.kind)).toEqual([
      "access",
      "access",
      "access",
      "email",
      "email",
      "workers",
      "workers",
      "certificates",
      "d1",
      "d1",
      "kv",
      "kv",
      "dns",
    ]);
    expect(
      plan.items.find((item) => item.kind === "d1" && item.id === "db-gw")
        ?.name,
    ).toBe("every-app-gateway");
    expect(plan.items.find((item) => item.kind === "dns")).toEqual({
      kind: "dns",
      id: "rec1",
      name: "A at apps.everyapp-loop1.com",
    });
    expect(
      plan.items
        .filter((item) => item.kind === "email")
        .map((item) => item.name),
    ).toEqual([
      "rule for hi@everyapp-loop1.com on everyapp-loop1.com",
      "Email Routing on everyapp-loop1.com",
    ]);
    expect(flattenPlan(null, "t")).toMatchObject({ total: 0, items: [] });
  });

  it("reads a runId's minute and finds the markers that block a wipe: live-locked ones, young ones with no lock here, never a dead lock's or this run's", () => {
    expect(runIdTime("2026-10-25T10:30-claude-abc123")).toBe(
      Date.parse("2026-10-25T10:30:00Z"),
    );
    expect(runIdTime("garbage")).toBeNull();
    const now = Date.parse("2026-10-25T12:00:00Z");
    const titles = [
      markerTitle("2026-10-25T11:30-claude-aaa"),
      markerTitle("2026-10-25T09:00-codex-bbb"),
      markerTitle(RUN_ID),
      markerTitle("weird"),
      "every-app-gateway-OAUTH_KV",
    ];
    expect(blockingMarkers(titles, RUN_ID, now)).toEqual([
      "every-loop-run-2026-10-25T11:30-claude-aaa",
      "every-loop-run-weird",
    ]);
    // With the locks known: a dead lock's marker is stale at 30 minutes, a live lock's blocks at
    // 3 hours, and one this machine has no lock for (another machine's run?) keeps the age rule.
    expect(
      blockingMarkers(titles, RUN_ID, now, {
        live: [],
        dead: ["2026-10-25T11:30-claude-aaa", "weird"],
      }),
    ).toEqual([]);
    expect(
      blockingMarkers(titles, RUN_ID, now, {
        live: ["2026-10-25T09:00-codex-bbb", RUN_ID],
        dead: [],
      }),
    ).toEqual([
      "every-loop-run-2026-10-25T11:30-claude-aaa",
      "every-loop-run-2026-10-25T09:00-codex-bbb",
      "every-loop-run-weird",
    ]);
    expect(
      blockingMarkers(titles, RUN_ID, now, {
        live: [RUN_ID],
        dead: ["2026-10-25T11:30-claude-aaa"],
      }),
    ).toEqual(["every-loop-run-weird"]);
  });

  it("the confirm file counts only with the exact sentence and mode 600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-confirm-"));
    const file = path.join(dir, `confirm-${ID}`);
    expect(readConfirmFile(file, ID)).toBeNull();
    fs.writeFileSync(file, `delete everything in ${ID}\n`, { mode: 0o644 });
    expect(readConfirmFile(file, ID)).toBeNull();
    fs.chmodSync(file, 0o600);
    expect(readConfirmFile(file, ID)).toBe(ID);
    fs.writeFileSync(file, "yes\n", { mode: 0o600 });
    expect(readConfirmFile(file, ID)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds records at or under apps.<zone> only", () => {
    const records = [
      { id: "1", type: "A", name: "apps.everyapp-loop1.com", content: null },
      {
        id: "2",
        type: "CNAME",
        name: "hello.apps.everyapp-loop1.com.",
        content: null,
      },
      { id: "3", type: "MX", name: "everyapp-loop1.com", content: null },
      { id: "4", type: "A", name: "myapps.everyapp-loop1.com", content: null },
    ];
    expect(
      recordsUnderGateway(records, "everyapp-loop1.com").map((r) => r.id),
    ).toEqual(["1", "2"]);
  });
});

describe("createRunMarker", () => {
  it("puts the run's marker in the account as an every-* KV namespace", async () => {
    const fake = createFakeCfFetch([
      {
        method: "POST",
        path: /\/storage\/kv\/namespaces$/,
        reply: (_m, call) => ({
          result: { id: "kv9", title: (call.body as { title: string }).title },
        }),
      },
    ]);
    await createRunMarker(
      createCfApi({ token: account.token, accountId: ID, fetch: fake.fetch }),
      RUN_ID,
    );
    expect(fake.calls[0]?.body).toEqual({ title: markerTitle(RUN_ID) });
  });
});

describe("removeRunMarker", () => {
  it("deletes the run's own marker by its exact title and nothing else", async () => {
    const fake = createFakeCfFetch([
      {
        method: "GET",
        path: /\/storage\/kv\/namespaces$/,
        reply: () => ({
          result: [
            {
              id: "kv-other",
              title: markerTitle("2026-10-25T11:30-claude-zzz"),
            },
            { id: "kv-own", title: markerTitle(RUN_ID) },
            { id: "kv-gw", title: "every-app-gateway-OAUTH_KV" },
          ],
        }),
      },
      {
        method: "DELETE",
        path: /\/storage\/kv\/namespaces\/kv-own$/,
        reply: () => ({ result: null }),
      },
    ]);
    const cf = createCfApi({
      token: account.token,
      accountId: ID,
      fetch: fake.fetch,
    });
    expect(await removeRunMarker(cf, RUN_ID)).toBe(true);
    expect(
      fake.calls.filter((call) => call.method === "DELETE").map((c) => c.path),
    ).toEqual([`/accounts/${ID}/storage/kv/namespaces/kv-own`]);
    expect(await removeRunMarker(cf, "2026-10-25T13:00-codex-none")).toBe(
      false,
    );
  });
});

describe("runTeardownStep", () => {
  it("an empty account: the dry run says 0, nothing is confirmed or deleted, DNS is checked", async () => {
    const sibling = fakeSibling([[done(emptyPlan)]]);
    let confirmed = false;
    const result = await runTeardownStep(
      base(sibling, {
        confirm: async () => {
          confirmed = true;
          return ID;
        },
      }),
    );
    expect(confirmed).toBe(false);
    expect(result.before.total).toBe(0);
    expect(result.after).toBe(result.before);
    expect(result.polls).toBe(0);
    expect(result.dnsLeftovers).toEqual([]);
    expect(sibling.calls).toEqual([
      [
        "pnpm",
        "everyapp",
        "teardown",
        "--account-id",
        ID,
        "--dry-run",
        "--json",
      ],
    ]);
  });

  it("a full account: plan, confirm with the id, delete, re-poll the dry run until 0", async () => {
    const sibling = fakeSibling([
      [done(fullPlan)],
      [
        done(fullPlan, {
          dryRun: false,
          removed: ['Worker "every-acme-hello"', 'Worker "every-app-gateway"'],
          kept: [{ described: "R2 bucket", reason: "has objects" }],
        }),
      ],
      [
        done({
          ...emptyPlan,
          total: 1,
          d1: [{ name: "every-app-gateway", id: "db-gw" }],
        }),
      ],
      [done(emptyPlan)],
    ]);
    const result = await runTeardownStep(base(sibling));
    expect(result.before.total).toBe(13);
    expect(result.removed).toHaveLength(2);
    expect(result.kept).toHaveLength(1);
    expect(result.polls).toBe(2);
    expect(result.after.total).toBe(0);
    expect(sibling.calls[1]).toEqual([
      "pnpm",
      "everyapp",
      "teardown",
      "--account-id",
      ID,
      "--confirm",
      ID,
      "--json",
    ]);
    expect(result.events.filter((event) => event.type === "done")).toHaveLength(
      4,
    );
  });

  it("a confirmation that is not the id deletes nothing", async () => {
    const sibling = fakeSibling([[done(fullPlan)]]);
    await expect(
      runTeardownStep(base(sibling, { confirm: async () => "yes" })),
    ).rejects.toThrow(/does not match/);
    expect(sibling.calls).toHaveLength(1);
  });

  it("--dry-run only plans, even on a full account", async () => {
    const sibling = fakeSibling([[done(fullPlan)]]);
    const result = await runTeardownStep(base(sibling, { dryRunOnly: true }));
    expect(result.before.total).toBe(13);
    expect(result.skipped).toContain(
      "deletion: --dry-run (13 resource(s) would go)",
    );
    expect(sibling.calls).toHaveLength(1);
  });

  it("leftovers past the poll deadline, a CLI error, and no events are each their own error", async () => {
    const stuck = fakeSibling([
      [done(fullPlan)],
      [done(fullPlan, { dryRun: false })],
      [done({ ...emptyPlan, total: 1 })],
      [done({ ...emptyPlan, total: 1 })],
      [done({ ...emptyPlan, total: 1 })],
    ]);
    let clock = NOW;
    const error = await runTeardownStep(
      base(stuck, { now: () => (clock += 400), pollDeadlineMs: 1000 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeardownStepError);
    expect((error as TeardownStepError).code).toBe("leftovers");

    const refused = fakeSibling([[errorEvent("TEARDOWN_TOKEN_TOO_BROAD")]]);
    await expect(runTeardownStep(base(refused))).rejects.toMatchObject({
      code: "cli_error",
      message: /TEARDOWN_TOKEN_TOO_BROAD/,
    });

    const silent = fakeSibling([
      ["> everyapp@0.3.0 everyapp", "pnpm: command not found"],
    ]);
    await expect(runTeardownStep(base(silent))).rejects.toMatchObject({
      code: "no_done",
    });
  });

  it("another run's young marker in the account refuses the wipe unless forced, naming the command that forces", async () => {
    const cf = cfWith([], [markerTitle("2026-10-25T11:30-claude-zzz")]);
    await expect(
      runTeardownStep(base(fakeSibling([[done(emptyPlan)]]), { cf })),
    ).rejects.toMatchObject({
      code: "marker_refused",
      message: expect.stringContaining(
        "`pnpm loop teardown --account loop-1 --force`",
      ),
    });
    const result = await runTeardownStep(
      base(fakeSibling([[done(emptyPlan)]]), { cf, force: true }),
    );
    expect(result.markers).toEqual([
      "every-loop-run-2026-10-25T11:30-claude-zzz",
    ]);
    const own = await runTeardownStep(
      base(fakeSibling([[done(emptyPlan)]]), {
        cf: cfWith([], [markerTitle(RUN_ID)]),
      }),
    );
    expect(own.markers).toEqual([markerTitle(RUN_ID)]);
  });

  it("with the locks known, a dead lock's marker is stale at any age, a live lock's blocks at any age, and one with no lock here keeps the age rule", async () => {
    const young = markerTitle("2026-10-25T11:30-claude-zzz");
    const old = markerTitle("2026-10-25T08:00-codex-yyy");
    const stale = await runTeardownStep(
      base(fakeSibling([[done(emptyPlan)]]), {
        cf: cfWith([], [young, old]),
        locks: { live: [RUN_ID], dead: ["2026-10-25T11:30-claude-zzz"] },
      }),
    );
    expect(stale.markers).toEqual([young, old]);
    await expect(
      runTeardownStep(
        base(fakeSibling([[done(emptyPlan)]]), {
          cf: cfWith([], [old]),
          locks: { live: [RUN_ID, "2026-10-25T08:00-codex-yyy"], dead: [] },
        }),
      ),
    ).rejects.toMatchObject({
      code: "marker_refused",
      message: `Another run left its marker in the account: ${old} still holds the lock here; if that run is really gone, \`pnpm loop teardown --account loop-1 --force\` wipes anyway.`,
    });
    // No lock here for the young one: a run on another machine, or under another
    // EVERYAPP_LOOP_HOME, could be using the account; the message says which marker and why.
    await expect(
      runTeardownStep(
        base(fakeSibling([[done(emptyPlan)]]), {
          cf: cfWith([], [young, old]),
          locks: { live: [RUN_ID], dead: [] },
        }),
      ),
    ).rejects.toMatchObject({
      code: "marker_refused",
      message: `Another run left its marker in the account: ${young} has no lock on this machine and is younger than 2 hours (a run elsewhere?); if that run is really gone, \`pnpm loop teardown --account loop-1 --force\` wipes anyway.`,
      data: [young],
    });
  });

  it("a DNS record left at or under apps.<zone> after the wipe is an error; without a Cloudflare client the check is skipped", async () => {
    const leftover = cfWith([
      {
        method: "GET",
        path: /^\/zones\/z1\/dns_records$/,
        reply: () => ({
          result: [
            {
              id: "r",
              type: "A",
              name: "hello.apps.everyapp-loop1.com",
              content: "1.2.3.4",
            },
          ],
        }),
      },
    ]);
    await expect(
      runTeardownStep(base(fakeSibling([[done(emptyPlan)]]), { cf: leftover })),
    ).rejects.toMatchObject({ code: "dns_leftovers" });
    const result = await runTeardownStep(
      base(fakeSibling([[done(emptyPlan)]]), { cf: null }),
    );
    expect(result.skipped).toEqual([
      "markers: no Cloudflare API (dry run)",
      "dns: no Cloudflare API (dry run)",
    ]);
  });
});
