import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../types";
import {
  computeCost,
  PRICE_TABLE,
  priceTokens,
  resolvedModel,
  sumTokens,
} from "./cost";
import {
  appFrom,
  codesSeen,
  everyappArgv,
  everyappCommandsFrom,
  ownerNotClaimedCause,
  parseEventLog,
  PARSER_VERSION,
  phasesFrom,
  setupSummary,
  toEveryappCommands,
} from "./eventLog";
import {
  detectHarnessTimeouts,
  detectHesitations,
  gapsOver60s,
  RULES_VERSION,
} from "./hesitations";
import {
  assistantText,
  lastSessionId,
  linkSurfacedToPerson,
  printedBlocked,
  printedDone,
  providerErrorAtExit,
  toolCallCounts,
} from "./transcript";

const LOG = [
  '{"type":"invocation","pid":41,"argv":["/usr/bin/node","/work/every-app/packages/cli/dist/bin/cli.js","setup","--domain","apps.everyapp-loop1.com","--json"],"cwd":"/work/every-app","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"2026-10-25T14:06:10.000Z"}',
  '{"v":1,"ts":"2026-10-25T14:06:12.000Z","type":"step","step":"setup.toolchain","status":"ok","pid":41}',
  '{"v":1,"ts":"2026-10-25T14:07:00.000Z","type":"step","step":"setup.gateway","status":"start","pid":41}',
  '{"v":1,"ts":"2026-10-25T14:09:00.000Z","type":"warning","code":"WORKERS_PAID_UNVERIFIED","step":"setup.plan","message":"m","pid":41}',
  '{"v":1,"ts":"2026-10-25T14:13:52.000Z","type":"step","step":"setup.gateway","status":"ok","pid":41}',
  '{"v":1,"ts":"2026-10-25T14:14:00.000Z","type":"action_required","action":"claim_owner","step":"setup.owner","message":"Open this link","data":{"url":"https://apps.everyapp-loop1.com/setup#token=est_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","waiting":true},"pid":41}',
  '{"v":1,"ts":"2026-10-25T14:14:09.000Z","type":"step","step":"setup.owner","status":"ok","message":"Owner account created","pid":41}',
  '{"v":1,"ts":"2026-10-25T14:15:10.000Z","type":"done","data":{"gatewayUrl":"https://apps.everyapp-loop1.com"},"pid":41}',
  '{"type":"exit","pid":41,"code":0,"ms":540000,"ts":"2026-10-25T14:15:10.000Z"}',
  '{"type":"invocation","pid":52,"argv":["create","hello","--json"],"cwd":"/work/every-app","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"2026-10-25T14:16:00.000Z"}',
  '{"v":1,"ts":"2026-10-25T14:17:35.000Z","type":"done","data":{"id":"hello"},"pid":52}',
  '{"type":"exit","pid":52,"code":0,"ms":95000,"ts":"2026-10-25T14:17:35.000Z"}',
  '{"type":"invocation","pid":60,"argv":["deploy"],"cwd":"/work/every-app/apps/hello","json":false,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"2026-10-25T14:18:00.000Z"}',
  '{"v":1,"ts":"2026-10-25T14:18:30.000Z","type":"error","code":"NOT_LOGGED_IN","message":"m","retryable":false,"pid":60}',
  '{"type":"exit","pid":60,"code":1,"ms":30000,"ts":"2026-10-25T14:18:30.000Z"}',
  '{"type":"invocation","pid":61,"argv":["deploy","--json"],"cwd":"/work/every-app/apps/hello","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"2026-10-25T14:19:00.000Z"}',
  '{"v":1,"ts":"2026-10-25T14:21:20.000Z","type":"done","data":{"url":"https://hello.apps.everyapp-loop1.com"},"pid":61}',
  '{"type":"exit","pid":61,"code":0,"ms":140000,"ts":"2026-10-25T14:21:20.000Z"}',
  "",
  "not json",
].join("\n");

describe("event log", () => {
  const traces = everyappCommandsFrom(parseEventLog(LOG));
  it("is versioned", () => {
    expect(PARSER_VERSION).toBe(1);
    expect(RULES_VERSION).toBe(1);
  });
  it("groups invocations, events and exits into commands with the launcher stripped", () => {
    expect(traces.map((t) => t.argv)).toEqual([
      ["setup", "--domain", "apps.everyapp-loop1.com", "--json"],
      ["create", "hello", "--json"],
      ["deploy"],
      ["deploy", "--json"],
    ]);
    expect(traces[0]).toMatchObject({
      json: true,
      ci: false,
      exit: 0,
      ms: 540000,
      endedBy: "exit",
      linkEmittedAt: "2026-10-25T14:14:00.000Z",
    });
    expect(traces[0]!.events).toMatchObject({
      warnings: ["WORKERS_PAID_UNVERIFIED"],
      actions: ["claim_owner"],
      errors: [],
      done: true,
    });
    expect(traces[2]).toMatchObject({
      json: false,
      exit: 1,
      events: { errors: ["NOT_LOGGED_IN"] },
    });
    expect(toEveryappCommands(traces)[0]).toEqual({
      argv: ["setup", "--domain", "apps.everyapp-loop1.com", "--json"],
      cwd: "/work/every-app",
      json: true,
      ci: false,
      exit: 0,
      ms: 540000,
      events: {
        warnings: ["WORKERS_PAID_UNVERIFIED"],
        actions: ["claim_owner"],
        errors: [],
      },
      endedBy: "exit",
    });
    expect(everyappArgv(["pnpm", "everyapp", "status", "--json"])).toEqual([
      "status",
      "--json",
    ]);
    expect(everyappArgv(["node_modules/.bin/everyapp", "status"])).toEqual([
      "status",
    ]);
  });
  it("leaves a killed command as endedBy unknown", () => {
    const killed = everyappCommandsFrom(
      parseEventLog(
        '{"type":"invocation","pid":9,"argv":["setup","--json"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"t"}\n{"v":1,"ts":"t","type":"step","step":"setup.gateway","status":"start"}',
      ),
    );
    expect(killed[0]).toMatchObject({ exit: null, endedBy: "unknown" });
    expect(killed[0]!.events.steps).toHaveLength(1);
  });
  it("summarises setup, the app and the codes", () => {
    expect(setupSummary(traces)).toEqual({ status: "done", reruns: 0 });
    expect(setupSummary([])).toEqual({ status: "never_ran", reruns: 0 });
    const stopped = everyappCommandsFrom(
      parseEventLog(
        '{"type":"invocation","pid":1,"argv":["setup","--json"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"t"}\n{"type":"exit","pid":1,"code":2,"ms":1,"ts":"t"}\n{"type":"invocation","pid":2,"argv":["setup","--json"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"t"}\n{"type":"exit","pid":2,"code":2,"ms":1,"ts":"t"}',
      ),
    );
    expect(setupSummary(stopped)).toEqual({
      status: "action_required",
      reruns: 1,
    });
    expect(appFrom(traces)).toEqual({
      created: "hello",
      deployed: true,
      url: "https://hello.apps.everyapp-loop1.com",
    });
    expect(codesSeen(traces)).toEqual([
      "claim_owner",
      "WORKERS_PAID_UNVERIFIED",
      "NOT_LOGGED_IN",
    ]);
  });
  it("explains OWNER_NOT_CLAIMED", () => {
    const dropped = everyappCommandsFrom(
      parseEventLog(
        '{"type":"invocation","pid":1,"argv":["setup"],"cwd":"/w","json":false,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"t"}\n{"v":1,"ts":"t","type":"warning","code":"OWNER_NOT_CLAIMED","message":"m"}',
      ),
    );
    expect(ownerNotClaimedCause(dropped)).toBe("dropped_json_flag");
    const ci = everyappCommandsFrom(
      parseEventLog(
        '{"type":"invocation","pid":1,"argv":["setup","--json"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":true,"ts":"t"}\n{"v":1,"ts":"t","type":"warning","code":"OWNER_NOT_CLAIMED","message":"m"}',
      ),
    );
    expect(ownerNotClaimedCause(ci)).toBe("ci_set_by_harness");
    expect(ownerNotClaimedCause(traces)).toBeNull();
  });
  it("derives phases from the CLI's own timestamps", () => {
    expect(phasesFrom(traces)).toEqual([
      { name: "setup", startedAt: "2026-10-25T14:06:10.000Z", durationS: 540 },
      {
        name: "setup.gateway",
        startedAt: "2026-10-25T14:07:00.000Z",
        durationS: 412,
      },
      {
        name: "setup.owner",
        startedAt: "2026-10-25T14:14:00.000Z",
        durationS: 9,
      },
      { name: "create", startedAt: "2026-10-25T14:16:00.000Z", durationS: 95 },
      { name: "deploy", startedAt: "2026-10-25T14:18:00.000Z", durationS: 30 },
      { name: "deploy", startedAt: "2026-10-25T14:19:00.000Z", durationS: 140 },
    ]);
  });
});

const ev = (
  kind: NormalizedEvent["kind"],
  fields: Partial<NormalizedEvent> = {},
): NormalizedEvent => ({
  receivedAt: fields.ts ?? "2026-10-25T14:00:00.000Z",
  kind,
  raw: fields.raw ?? null,
  ...fields,
});

describe("hesitations", () => {
  const commands = toEveryappCommands(everyappCommandsFrom(parseEventLog(LOG)));
  it("finds each kind", () => {
    const events: NormalizedEvent[] = [
      ev("tool_call", {
        tool: "Read",
        text: "/work/every-app/landing-page/content/agent/setup.md",
        ts: "2026-10-25T14:01:00.000Z",
      }),
      ev("tool_call", {
        tool: "Read",
        text: "/work/every-app/landing-page/content/agent/setup.md",
        ts: "2026-10-25T14:01:30.000Z",
      }),
      ev("tool_call", {
        tool: "Bash",
        argv: ["cat", "packages/cli/src/commands/setup/runSetup.ts"],
        ts: "2026-10-25T14:02:00.000Z",
      }),
      ev("tool_call", {
        tool: "Bash",
        argv: [
          "pnpm",
          "everyapp",
          "setup",
          "--domain",
          "apps.everyapp-loop1.com",
          "--json",
        ],
        ts: "2026-10-25T14:06:00.000Z",
      }),
      ev("tool_result", {
        text: "Command did not complete within its 120s timeout and was moved to the background",
        ts: "2026-10-25T14:08:00.000Z",
      }),
      ev("tool_result", {
        text: "…",
        truncated: true,
        outputChars: 5000,
        tool: "terminal",
        ts: "2026-10-25T14:09:00.000Z",
      }),
      ev("tool_call", {
        tool: "AskUserQuestion",
        text: "Which domain?",
        ts: "2026-10-25T14:10:00.000Z",
      }),
      ev("assistant_text", {
        text: "Setup is running. Let me know when the owner account is created.",
        ts: "2026-10-25T14:11:00.000Z",
      }),
      ev("result", {
        text: "Setup is running. Let me know when the owner account is created.",
        raw: { permission_denials: [{ tool: "Bash" }] },
        ts: "2026-10-25T14:11:01.000Z",
      }),
    ];
    const found = detectHesitations(events, commands);
    const kinds = found.map((h) => h.kind);
    expect(kinds).toContain("docs_reread");
    expect(kinds).toContain("source_read");
    expect(kinds).toContain("moved_to_background");
    expect(kinds).toContain("tool_output_truncated");
    expect(kinds).toContain("asked_user");
    expect(kinds).toContain("ended_turn_without_done");
    expect(kinds).toContain("repeated_command");
    expect(kinds).toContain("dropped_json_flag");
    const moved = found.find((h) => h.kind === "moved_to_background")!;
    expect(moved.precededBy).toEqual({
      argv: ["setup", "--domain", "apps.everyapp-loop1.com", "--json"],
      exit: 0,
    });
    expect(moved.triage).toBe("harness");
    expect(moved.excerpt.length).toBeLessThanOrEqual(200);
    expect(
      found.find((h) => h.kind === "dropped_json_flag")?.precededBy?.argv,
    ).toEqual(["deploy"]);
    expect(found.filter((h) => h.kind === "docs_reread")).toHaveLength(1);
  });
  it("does not call a turn that printed DONE a hesitation", () => {
    expect(
      detectHesitations(
        [
          ev("assistant_text", { text: "DONE https://apps.x" }),
          ev("result", { text: "DONE https://apps.x" }),
        ],
        [],
      ),
    ).toEqual([]);
  });
  it("reads harness timeouts and gaps", () => {
    const events: NormalizedEvent[] = [
      ev("tool_call", {
        argv: ["pnpm", "everyapp", "setup", "--json"],
        ts: "2026-10-25T14:06:00.000Z",
      }),
      ev("tool_result", {
        text: "Command did not complete within its 120s timeout and was moved to the background",
        ts: "2026-10-25T14:08:00.000Z",
      }),
      ev("tool_call", { argv: ["sleep", "1"], ts: "2026-10-25T14:10:00.000Z" }),
      ev("tool_result", { text: "ok", ts: "2026-10-25T14:10:01.000Z" }),
      ev("tool_call", { argv: ["pwd"], ts: "2026-10-25T14:10:30.000Z" }),
    ];
    expect(detectHarnessTimeouts(events)).toEqual([
      {
        at: "2026-10-25T14:08:00.000Z",
        what: "setup",
        limitS: 120,
        action: "backgrounded",
      },
    ]);
    expect(gapsOver60s(events)).toBe(1);
  });
});

describe("cost", () => {
  const signal = {
    toolCalls: "full",
    toolOutput: "full",
    exitCodes: true,
    cost: "harness",
    resume: "native",
  } as const;
  it("takes Claude's cumulative figure per process and never sums within one", () => {
    const p1 = [
      ev("result", { costUsd: 1.5, tokens: { input: 10, output: 5 } }),
      ev("result", { costUsd: 4.25, tokens: { input: 20, output: 7 } }),
    ];
    const p2 = [
      ev("result", { costUsd: 3.59, tokens: { input: 30, output: 9 } }),
    ];
    const cost = computeCost("claude", signal, "claude-opus-5-5", [p1, p2]);
    expect(cost.usd).toBe(7.84);
    expect(cost.source).toBe("harness");
    expect(cost.tokens).toEqual({ input: 60, output: 21 });
  });
  it("sums OpenCode's per-step cost and tokens from turn_end events", () => {
    const events = [
      ev("turn_end", {
        costUsd: 0.01,
        tokens: { input: 100, output: 10, cacheRead: 5 },
      }),
      ev("turn_end", { costUsd: 0.02, tokens: { input: 200, output: 20 } }),
      ev("result", { costUsd: 0.02, tokens: { input: 200, output: 20 } }),
    ];
    const cost = computeCost("opencode", signal, "opencode/glm-5.3", [events]);
    expect(cost.usd).toBe(0.03);
    expect(cost.tokens).toEqual({ input: 300, output: 30, cacheRead: 5 });
  });
  it("prices Codex and Hermes from the dated table, null when the model has no row", () => {
    expect(PRICE_TABLE.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      priceTokens("opencode/glm-5.3-flash", {
        input: 1_000_000,
        output: 1_000_000,
      }),
    ).toBe(0.65);
    expect(priceTokens("gpt-5.3-codex", { input: 1 })).toBeNull();
    const cost = computeCost(
      "codex",
      { ...signal, cost: "tokens_x_list" },
      "gpt-5.3-codex",
      [
        [
          ev("result", {
            tokens: { input: 40717, output: 79, cacheRead: 33408 },
          }),
        ],
      ],
    );
    expect(cost).toEqual({
      usd: null,
      source: "tokens_x_list",
      tokens: { input: 40717, output: 79, cacheRead: 33408 },
      model: "gpt-5.3-codex",
    });
    expect(sumTokens([], "codex")).toEqual({});
  });
  it("is null with source none for Cursor", () => {
    expect(
      computeCost("cursor", { ...signal, cost: "none" }, "opus-4.5", [
        [ev("result")],
      ]),
    ).toEqual({ usd: null, source: "none", tokens: {}, model: "opus-4.5" });
  });
  it("takes the resolved model from the first event that names one", () => {
    expect(
      resolvedModel([
        ev("tool_call"),
        ev("assistant_text", { model: "claude-opus-5-5-20261001" }),
      ]),
    ).toBe("claude-opus-5-5-20261001");
    expect(resolvedModel([])).toBeNull();
  });
});

describe("transcript", () => {
  const events = [
    ev("assistant_text", {
      text: "Please open this link to create the owner: https://apps.x/setup#token=est_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sessionId: "s1",
    }),
    ev("tool_call", { tool: "Bash", argv: ["pwd"] }),
    ev("tool_call", { tool: "Read", text: "x" }),
    ev("tool_call", { tool: "Bash", argv: ["ls"] }),
    ev("result", {
      text: "All done.\nDONE https://apps.everyapp-loop1.com",
      sessionId: "s2",
    }),
  ];
  it("reads DONE, BLOCKED, the surfaced link, the session and tool counts", () => {
    expect(printedDone(events)).toEqual({
      done: true,
      url: "https://apps.everyapp-loop1.com",
    });
    expect(printedBlocked(events)).toBeNull();
    expect(
      printedBlocked([
        ev("assistant_text", { text: "BLOCKED: no Workers Paid" }),
      ]),
    ).toBe("no Workers Paid");
    expect(linkSurfacedToPerson(events)).toBe(true);
    expect(
      linkSurfacedToPerson([
        ev("assistant_text", { text: "Setup is running." }),
      ]),
    ).toBe(false);
    expect(lastSessionId(events)).toBe("s2");
    expect(toolCallCounts(events)).toEqual({ Bash: 2, Read: 1 });
    expect(assistantText(events)).toContain("DONE");
  });
  it("sees a provider error at exit", () => {
    expect(
      providerErrorAtExit([
        ev("result", {
          isError: true,
          text: "Not logged in",
          stopReason: "api_error",
        }),
      ]),
    ).toBe(true);
    expect(
      providerErrorAtExit([
        ev("result", { isError: true, text: "429 rate limit" }),
      ]),
    ).toBe(true);
    expect(providerErrorAtExit(events)).toBe(false);
  });
});
