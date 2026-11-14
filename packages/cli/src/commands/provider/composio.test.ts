/**
 * `provider link composio` and `provider unlink composio` are thin clients:
 * each names the Gateway's tools and shows what they answer. These pin
 * which tools, when `link` asks again, and what a person and an agent are
 * told; the tools themselves are the Gateway's
 * (composio-tools.sqlite.test.ts).
 */
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBuiltinTools } from "@every-app/toolbus";
import { EveryAppError } from "@/lib/errors";
import type { GatewayApi, JsonObject } from "@/lib/gatewayApi";

const GATEWAY = "https://apps.example.com";
const SIGN_IN = "https://dashboard.composio.dev/?cliKey=signin_1";
const EXPIRES = "2026-11-13T12:10:00.000Z";

const calls: Array<[string, JsonObject]> = [];
/** What each tool answers, in order; an Error is thrown instead. The last one repeats. */
let answers: Record<string, Array<JsonObject | Error>> = {};

vi.mock("@/lib/gatewayApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gatewayApi")>()),
  openGatewayApi: async (): Promise<GatewayApi> => ({
    gateway: GATEWAY,
    call: async (name, args = {}) => {
      calls.push([name, args]);
      const queue = answers[name] ?? [];
      const answer = queue.length > 1 ? queue.shift()! : queue[0];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
    list: async () => [],
  }),
}));

const opened: string[] = [];
vi.mock("@/lib/gateway/setup-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway/setup-link")>()),
  openInBrowser: async (url: string) => (opened.push(url), true),
}));

const composio = await import("./composio");

const STATUS = "everyapp_provider_composio";
const LINK = "everyapp_provider_composio_link";
const FINISH = "everyapp_provider_composio_link_finish";
const UNLINK = "everyapp_provider_composio_unlink";

/** The organization has Composio on, and the person hasn't linked. */
const NOT_LINKED: JsonObject = { composio: "on", linked: false, account: null, providers: null, next: "…" };

/** What is in the person's Composio, as the tools answer it once linked. */
const LINKED: JsonObject = {
  composio: "on",
  linked: true,
  account: "alex@example.com",
  providers: [
    {
      provider: "google-workspace",
      providerName: "Google",
      services: [
        { name: "Gmail", accounts: ["alex@example.com"] },
        { name: "Calendar", accounts: ["alex@example.com", "work@example.com"] },
      ],
      connected: true,
    },
    { provider: "github-oauth", providerName: "GitHub", services: [{ name: "GitHub", accounts: ["alexdev"] }], connected: false },
  ],
  next: "…",
};

const NOTHING_ADDED = "An account becomes a connection when an app asks for it and you say yes.";

/** What a person reads once linked, under the first line. */
const FOUND = [
  "",
  "In your Composio:",
  "  Google  Gmail (alex@example.com), Calendar (alex@example.com, work@example.com) · connected",
  "  GitHub  GitHub (alexdev)",
  "",
  NOTHING_ADDED,
  "",
];

const lines: string[] = [];
const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
function atTerminal(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: on, configurable: true });
}

beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  opened.length = 0;
  answers = {};
  vi.stubEnv("CI", "");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: terminal.stdin, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: terminal.stderr, configurable: true });
});

const json = { json: true } as const;
const events = () => lines.map((line) => JSON.parse(line) as JsonObject);
const event = (type: string) => events().find((each) => each["type"] === type);
/** What a person read: stdout and stderr in order, colors off. */
const printed = () => stripVTControlCharacters(lines.join(""));

/** The Gateway's refusal of a tool call, as lib/gatewayApi raises it. */
const refused = (tool: string, code: string, message: string) =>
  new EveryAppError("GATEWAY_TOOL_ERROR", message, { data: { gateway: GATEWAY, tool, code } });

describe("provider link composio", () => {
  it("names only tools the Gateway has, and sends them no arguments", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [{ state: "linked", ...LINKED }],
    };
    vi.useFakeTimers();
    const linking = composio.link(json);
    await vi.advanceTimersByTimeAsync(2000);
    await linking;
    await composio.unlink(json);

    expect(calls).toEqual([
      [STATUS, {}],
      [LINK, {}],
      [FINISH, {}],
      [UNLINK, {}],
    ]);
    const builtin = new Set(listBuiltinTools().map((tool) => tool.name));
    for (const [name] of calls) expect(builtin.has(name), name).toBe(true);
  });

  it("under --json, hands the sign-in's page to the person as an action the run waits for, asks every two seconds, and ends on what was found", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES, next: "…" }],
      [FINISH]: [{ state: "waiting" }, { state: "waiting" }, { state: "linked", ...LINKED }],
    };
    vi.useFakeTimers();
    const linking = composio.link(json);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map(([name]) => name)).toEqual([STATUS, LINK]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      type: "action_required",
      action: "composio_sign_in",
      step: "provider.composio.link",
      message:
        "Approve the sign-in at Composio",
      data: { gateway: GATEWAY, url: SIGN_IN, expiresAt: EXPIRES, waiting: true, waitingFor: "your approval" },
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(4);
    expect(event("done")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    await linking;

    expect(calls.slice(2)).toEqual([
      [FINISH, {}],
      [FINISH, {}],
      [FINISH, {}],
    ]);
    expect(events()).toHaveLength(2);
    expect(event("done")).toMatchObject({
      message: [
        "Linked Composio as alex@example.com",
        "In your Composio: Google: Gmail (alex@example.com), Calendar (alex@example.com, work@example.com); GitHub: GitHub (alexdev)",
        NOTHING_ADDED,
      ].join("\n"),
      data: {
        gateway: GATEWAY,
        tool: FINISH,
        state: "linked",
        account: "alex@example.com",
        providers: LINKED["providers"],
      },
    });
    // The page is in the action alone, and nobody's browser is opened for an agent.
    expect(JSON.stringify(event("done"))).not.toContain("cliKey");
    expect(opened).toEqual([]);
    // The run waited and went on: it ends done, exit 0.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("at a terminal, prints the page on a line of its own, opens it, and lists each provider found with its services and their accounts", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [{ state: "linked", ...LINKED }],
    };
    atTerminal(true);
    vi.useFakeTimers();
    const linking = composio.link({});
    await vi.advanceTimersByTimeAsync(2000);
    await linking;

    expect(opened).toEqual([SIGN_IN]);
    expect(printed()).toBe(
      [
        "→ Approve the sign-in at Composio",
        `  ${SIGN_IN}`,
        // Where stdout is a terminal, a spinner says "Waiting for your approval" until it is approved.
        "✓ Linked Composio as alex@example.com",
        ...FOUND,
      ].join("\n"),
    );
  });

  it("prints the page and opens no browser where nobody is at a terminal", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [{ state: "linked", ...LINKED }],
    };
    atTerminal(false);
    vi.useFakeTimers();
    const linking = composio.link({});
    await vi.advanceTimersByTimeAsync(2000);
    await linking;

    expect(opened).toEqual([]);
    expect(printed()).toContain(`→ Approve the sign-in at Composio\n  ${SIGN_IN}\n`);
    expect(printed()).toContain("✓ Linked Composio as alex@example.com\n");
  });

  it("run by someone already linked, skips the sign-in and lists what is in their Composio now", async () => {
    answers = { [STATUS]: [LINKED] };
    await composio.link(json);
    expect(calls).toEqual([[STATUS, {}]]);
    expect(events()).toHaveLength(1);
    expect(event("done")).toMatchObject({
      message: expect.stringMatching(/^Composio is already linked as alex@example\.com\nIn your Composio: Google: Gmail/),
      data: { gateway: GATEWAY, tool: STATUS, linked: true, account: "alex@example.com", providers: LINKED["providers"] },
    });

    lines.length = 0;
    await composio.link({});
    expect(opened).toEqual([]);
    expect(printed()).toBe(["✓ Composio is already linked as alex@example.com", ...FOUND].join("\n"));
  });

  it("says so when nothing EveryApp supports is connected there, and when Composio didn't answer", async () => {
    answers = { [STATUS]: [{ ...LINKED, providers: [] }] };
    await composio.link({});
    expect(printed()).toBe(
      [
        "✓ Composio is already linked as alex@example.com",
        "",
        "Nothing EveryApp supports is connected in your Composio yet.",
        "",
        NOTHING_ADDED,
        "",
      ].join("\n"),
    );

    lines.length = 0;
    answers = { [STATUS]: [{ ...LINKED, providers: null }] };
    await composio.link({});
    expect(printed()).toBe(
      [
        "✓ Composio is already linked as alex@example.com",
        "",
        "Composio didn't answer, so what is in your Composio isn't listed.",
        "",
        NOTHING_ADDED,
        "",
        "Next:",
        "  pnpm everyapp provider link composio  lists what is in it",
        "",
      ].join("\n"),
    );
  });

  it("stops with COMPOSIO_OFF while the organization has Composio off, naming the one command that turns it on", async () => {
    answers = { [STATUS]: [{ composio: "off", linked: false, account: null, providers: null, next: "…" }] };
    await composio.link(json);
    expect(calls).toEqual([[STATUS, {}]]);
    expect(events()).toHaveLength(1);
    expect(event("error")).toMatchObject({
      code: "COMPOSIO_OFF",
      message: "Composio is off for this organization\nAn owner or admin turns it on. Nothing was linked.",
      retryable: false,
      data: { gateway: GATEWAY, rerun: "pnpm everyapp workspace composio on", rerunNote: "then link again" },
    });

    lines.length = 0;
    await composio.link({});
    expect(printed()).toBe(
      [
        "✗ Composio is off for this organization",
        "  An owner or admin turns it on. Nothing was linked.",
        "  Run: pnpm everyapp workspace composio on then link again",
        "",
      ].join("\n"),
    );
  });

  it("stops with COMPOSIO_LINK_EXPIRED when the sign-in ran out first, and its rerun starts another", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [{ state: "waiting" }, { state: "expired", next: "…" }],
    };
    vi.useFakeTimers();
    const linking = composio.link(json);
    await vi.advanceTimersByTimeAsync(4000);
    await linking;

    expect(calls).toHaveLength(4);
    expect(event("done")).toBeUndefined();
    const error = event("error")!;
    expect(error).toMatchObject({
      code: "COMPOSIO_LINK_EXPIRED",
      message: "The Composio sign-in ran out before it was approved\nNothing was linked.",
      retryable: false,
      data: { gateway: GATEWAY, rerun: expect.stringMatching(/^pnpm everyapp/), rerunNote: "starts a new one" },
    });
    expect(JSON.stringify(error)).not.toContain("cliKey");

    // What a person reads of it, under the page they were shown.
    lines.length = 0;
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [{ state: "expired", next: "…" }],
    };
    const again = composio.link({});
    await vi.advanceTimersByTimeAsync(2000);
    await again;
    // The rerun is this run's own command (here the test runner's, with no arguments).
    expect(printed()).toMatch(
      /\n✗ The Composio sign-in ran out before it was approved\n {2}Nothing was linked\.\n {2}Run: pnpm everyapp.* starts a new one\n$/,
    );
  });

  it("stops on the Gateway's refusal, when starting and when asking", async () => {
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [refused(LINK, "COMPOSIO_UNAVAILABLE", "Composio could not be reached. Try again.")],
    };
    await composio.link(json);
    expect(calls.map(([name]) => name)).toEqual([STATUS, LINK]);
    expect(events()).toHaveLength(1);
    expect(event("error")).toMatchObject({
      code: "GATEWAY_TOOL_ERROR",
      message: "Composio could not be reached. Try again.",
      data: { code: "COMPOSIO_UNAVAILABLE" },
    });

    calls.length = 0;
    lines.length = 0;
    answers = {
      [STATUS]: [NOT_LINKED],
      [LINK]: [{ url: SIGN_IN, expiresAt: EXPIRES }],
      [FINISH]: [refused(FINISH, "COMPOSIO_LINK_FAILED", "Composio approved the sign-in, but the link could not be finished. Start again.")],
    };
    vi.useFakeTimers();
    const linking = composio.link(json);
    await vi.advanceTimersByTimeAsync(2000);
    await linking;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toHaveLength(3);
    expect(events().at(-1)).toMatchObject({
      type: "error",
      code: "GATEWAY_TOOL_ERROR",
      data: { tool: FINISH, code: "COMPOSIO_LINK_FAILED" },
    });
  });
});

describe("provider unlink composio", () => {
  it("says the connections made through it are gone, and that the key stays valid at Composio", async () => {
    answers = { [UNLINK]: [{ removed: true, next: "…" }] };
    await composio.unlink(json);
    expect(event("done")).toMatchObject({
      message:
        "Unlinked Composio\nThe connections made through it are gone.\nThe key stays valid at Composio until you revoke it there.",
      data: { gateway: GATEWAY, tool: UNLINK, removed: true },
    });

    lines.length = 0;
    await composio.unlink({});
    expect(printed()).toBe(
      [
        "✓ Unlinked Composio",
        "",
        "The connections made through it are gone.",
        "The key stays valid at Composio until you revoke it there.",
        "",
      ].join("\n"),
    );
  });

  it("says so when there was no link, as an answer and not an error", async () => {
    answers = { [UNLINK]: [{ removed: false, next: "…" }] };
    await composio.unlink(json);
    expect(event("error")).toBeUndefined();
    expect(event("done")).toMatchObject({ message: "Composio was already unlinked", data: { removed: false } });

    lines.length = 0;
    await composio.unlink({});
    expect(printed()).toBe("✓ Composio was already unlinked\n");
  });
});
