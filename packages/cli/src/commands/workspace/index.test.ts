/**
 * The admin commands are thin clients: each names one Gateway tool and
 * hands it its flags. These pin which tool and which arguments; the tools
 * themselves are the Gateway's (workspace-tools.sqlite.test.ts).
 */
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBuiltinTools } from "@every-app/toolbus";
import { COMPOSIO_NOTICE } from "@every-app/sdk/internal";
import { EveryAppError } from "@/lib/errors";
import type { GatewayApi, JsonObject } from "@/lib/gatewayApi";

const calls: Array<[string, JsonObject]> = [];
let answer: JsonObject = {};
/** What a call answers when a test says so by tool and arguments; an Error is thrown instead. */
let respond: ((name: string, args: JsonObject) => JsonObject | Error) | null = null;

vi.mock("@/lib/gatewayApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gatewayApi")>()),
  openGatewayApi: async (): Promise<GatewayApi> => ({
    gateway: "https://apps.example.com",
    call: async (name, args = {}) => {
      calls.push([name, args]);
      const answered = respond ? respond(name, args) : answer;
      if (answered instanceof Error) throw answered;
      return answered;
    },
    list: async () => [],
  }),
}));

const workspace = await import(".");
const events = await import("../events");
const ai = await import("../ai");

const lines: string[] = [];
const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
/** A person at a terminal, or nobody. */
function atTerminal(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: on, configurable: true });
}
beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  answer = {};
  respond = null;
  vi.stubEnv("CI", "");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: terminal.stdin, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: terminal.stderr, configurable: true });
});

const json = { json: true } as const;
const emitted = () => lines.map((line) => JSON.parse(line) as JsonObject);
const done = () => emitted().find((event) => event["type"] === "done");
/** What a person read: stdout and stderr in order, colors off. */
const printed = () => stripVTControlCharacters(lines.join(""));

describe("the workspace commands", () => {
  it("each call one tool with its flags as arguments", async () => {
    await workspace.invite({ ...json, role: "admin" }, "ann@example.com");
    await workspace.role(json, "sam@example.com", "owner");
    await workspace.remove({ ...json, yes: true }, "ann@example.com");
    await workspace.groupMembers({ ...json, add: ["ann@example.com"] }, "Sales");
    await workspace.groupMembers(json, "Sales");
    await workspace.appAccess({ ...json, set: ["a@x.co", "b@x.co"] }, "crm");
    await workspace.appCap(json, "crm", "off");
    await workspace.appCap({ ...json, unlimited: true }, "crm");
    await workspace.capDefault(json, 20);
    await workspace.activity({ ...json, decision: "blocked", before: { at: 5, id: "c1" } });
    await workspace.audit({ ...json, type: "member.*", before: { at: 7, id: "e1" } });
    await workspace.linkedDev(json, "on");
    await workspace.linkedDev(json);
    expect(calls).toEqual([
      ["everyapp_workspace_invite", { email: "ann@example.com", role: "admin" }],
      ["everyapp_workspace_role", { user: "sam@example.com", role: "owner" }],
      ["everyapp_workspace_remove", { user: "ann@example.com", confirm: true }],
      ["everyapp_workspace_group_members_set", { group: "Sales", add: ["ann@example.com"] }],
      ["everyapp_workspace_group_members", { group: "Sales" }],
      ["everyapp_workspace_app_access_set", { app: "crm", users: ["a@x.co", "b@x.co"] }],
      ["everyapp_workspace_app_cap", { app: "crm", costUsd: null }],
      ["everyapp_workspace_app_cap", { app: "crm", unlimited: true }],
      ["everyapp_workspace_cap_default", { costUsd: 20 }],
      ["everyapp_workspace_activity", { decision: "blocked", before: { createdAt: 5, id: "c1" } }],
      ["everyapp_workspace_audit", { type: "member.*", before: { time: 7, id: "e1" } }],
      ["everyapp_workspace_linked_dev", { on: true }],
      ["everyapp_workspace_show", {}],
    ]);
  });

  it("asks before an irreversible tool, and refuses without --yes where nobody can answer", async () => {
    await workspace.remove(json, "ann@example.com");
    expect(calls).toEqual([]);
    const error = lines.map((line) => JSON.parse(line) as JsonObject).find((event) => event["type"] === "error");
    expect(error).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("puts the tool's answer in done.data", async () => {
    answer = { members: [{ email: "ann@example.com" }], invitations: [] };
    await workspace.users(json);
    expect(done()).toMatchObject({
      message: "1 members, 0 pending invitations",
      data: { gateway: "https://apps.example.com", tool: "everyapp_workspace_users", members: [{ email: "ann@example.com" }] },
    });
  });

  it("name only tools the Gateway has", async () => {
    await workspace.show(json);
    await workspace.tokens(json);
    await workspace.connections(json);
    await workspace.resetEmail(json, "ann@example.com");
    await events.list(json);
    await events.enable(json, "sub_1");
    await events.deliveries({ ...json, dead: true }, "sub_1");
    await events.add({ ...json, events: ["cap.*,member.*"] }, "https://hooks.example.com/x");
    await ai.show(json);
    await ai.setDefault(json, "openrouter/anthropic/claude-sonnet-5.5");
    await ai.setDefault(json, "off");
    const known = new Set(listBuiltinTools().map((tool) => tool.name));
    expect(calls.map(([name]) => name).filter((name) => !known.has(name))).toEqual([]);
    expect(calls.slice(-4)).toEqual([
      ["everyapp_workspace_events_add", { url: "https://hooks.example.com/x", events: ["cap.*", "member.*"] }],
      ["everyapp_ai_show", {}],
      ["everyapp_ai_default", { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" }],
      ["everyapp_ai_default", { clear: true }],
    ]);
  });
});

describe("workspace composio", () => {
  const TOOL = "everyapp_workspace_composio";
  it("show, the default, reads the switch from everyapp_workspace_show and changes nothing", async () => {
    answer = { organization: { name: "Acme" }, role: "owner", composio: "on" };
    await workspace.composio(json);
    await workspace.composio(json, "show");
    expect(calls).toEqual([
      ["everyapp_workspace_show", {}],
      ["everyapp_workspace_show", {}],
    ]);
    expect(done()).toMatchObject({
      message: "Composio is on",
      data: { gateway: "https://apps.example.com", tool: "everyapp_workspace_show", composio: "on" },
    });

    lines.length = 0;
    await workspace.composio({});
    expect(printed()).toBe("Composio is on\n");

    // Off, and off on a Gateway from before Composio, whose answer doesn't say.
    lines.length = 0;
    answer = { composio: "off" };
    await workspace.composio({}, "show");
    expect(printed()).toBe("Composio is off\n");
    lines.length = 0;
    answer = { organization: { name: "Acme" } };
    await workspace.composio({}, "show");
    expect(printed()).toBe("Composio is off\n");
  });

  it("on says what it means before turning it on, then names the command each person links with", async () => {
    answer = { composio: "on", changed: true, removed: { links: 0, connections: 0 } };
    await workspace.composio(json, "on");
    expect(calls).toEqual([[TOOL, { on: true }]]);
    // The sentence is said before the tool is called, and is in the result's account too.
    expect(emitted().map((event) => event["type"])).toEqual(["step", "done"]);
    expect(emitted()[0]).toMatchObject({ step: "composio.notice", status: "ok", message: COMPOSIO_NOTICE });
    expect(done()).toMatchObject({
      message: `Turned Composio on\n${COMPOSIO_NOTICE}\nEach person links their own Composio: pnpm everyapp provider link composio`,
      data: {
        tool: TOOL,
        composio: "on",
        changed: true,
        next: [{ command: "pnpm everyapp provider link composio", note: "link your own Composio" }],
      },
    });

    lines.length = 0;
    await workspace.composio({}, "on");
    expect(printed()).toBe(
      [
        "Requests to the accounts people use from Composio pass through Composio.",
        "✓ Turned Composio on",
        "",
        "Next:",
        "  pnpm everyapp provider link composio  link your own Composio",
        "",
      ].join("\n"),
    );

    lines.length = 0;
    answer = { composio: "on", changed: false, removed: { links: 0, connections: 0 } };
    await workspace.composio({}, "on");
    expect(printed()).toContain("✓ Composio was already on\n");
  });

  const QUESTION = "Turn Composio off? It deletes every link and every connection made through it. This can't be undone.";

  it("off asks first at a terminal, turns it off with confirm, and says how many links and connections it removed", async () => {
    answer = { composio: "off", changed: true, removed: { links: 2, connections: 3 } };
    atTerminal(true);
    const asked: string[] = [];
    await workspace.composio({}, "off", async (question) => (asked.push(question), true));
    expect(asked).toEqual([QUESTION]);
    expect(calls).toEqual([[TOOL, { on: false, confirm: true }]]);
    expect(printed()).toBe(
      ["✓ Turned Composio off", "", "Removed  2 links and 3 connections made through it", ""].join("\n"),
    );

    // Nothing was linked: no count to report.
    lines.length = 0;
    answer = { composio: "off", changed: true, removed: { links: 0, connections: 0 } };
    await workspace.composio({}, "off", async () => true);
    expect(printed()).toBe("✓ Turned Composio off\n");

    lines.length = 0;
    answer = { composio: "off", changed: false, removed: { links: 0, connections: 0 } };
    await workspace.composio({}, "off", async () => true);
    expect(printed()).toBe("✓ Composio was already off\n");

    // No: nothing is called.
    calls.length = 0;
    lines.length = 0;
    await workspace.composio({}, "off", async () => false);
    expect(calls).toEqual([]);
    expect(printed()).toBe("Cancelled. Nothing changed.\n");
    atTerminal(false);
  });

  it("off needs --yes where nobody can answer", async () => {
    answer = { composio: "off", changed: true, removed: { links: 2, connections: 3 } };
    await workspace.composio(json, "off");
    expect(calls).toEqual([]);
    const error = emitted().find((event) => event["type"] === "error");
    expect(error).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      message: `${QUESTION} That needs confirmation at a terminal, or --yes`,
      data: { tool: TOOL, authorize: true, rerun: expect.stringMatching(/--yes$/) },
    });
    expect(done()).toBeUndefined();

    // A terminal with --json is nobody to ask either.
    lines.length = 0;
    atTerminal(true);
    await workspace.composio(json, "off", async () => true);
    expect(calls).toEqual([]);
    expect(emitted().at(-1)).toMatchObject({ type: "error", code: "CONFIRMATION_REQUIRED" });
    atTerminal(false);

    lines.length = 0;
    await workspace.composio({ ...json, yes: true }, "off");
    expect(calls).toEqual([[TOOL, { on: false, confirm: true }]]);
    expect(done()).toMatchObject({
      message: "Turned Composio off\nRemoved 2 links and 3 connections made through it.",
      data: { tool: TOOL, composio: "off", changed: true, removed: { links: 2, connections: 3 } },
    });
  });

  it("passes on the Gateway's refusal as it is, and names only tools the Gateway has", async () => {
    respond = () =>
      new EveryAppError("GATEWAY_TOOL_ERROR", "Only an owner or admin can turn Composio on or off", {
        data: { gateway: "https://apps.example.com", tool: TOOL, code: "ADMIN_REQUIRED" },
      });
    await workspace.composio({ ...json, yes: true }, "off");
    expect(calls).toEqual([[TOOL, { on: false, confirm: true }]]);
    expect(emitted().at(-1)).toMatchObject({ type: "error", code: "GATEWAY_TOOL_ERROR", data: { code: "ADMIN_REQUIRED" } });

    const known = new Set(listBuiltinTools().map((tool) => tool.name));
    expect(known.has(TOOL)).toBe(true);
    expect(known.has("everyapp_workspace_show")).toBe(true);
  });
});
