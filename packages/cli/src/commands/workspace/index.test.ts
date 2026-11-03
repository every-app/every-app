/**
 * The admin commands are thin clients: each names one Gateway tool and
 * hands it its flags. These pin which tool and which arguments; the tools
 * themselves are the Gateway's (workspace-tools.sqlite.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBuiltinTools } from "@every-app/toolbus";
import type { GatewayApi, JsonObject } from "@/lib/gatewayApi";

const calls: Array<[string, JsonObject]> = [];
let answer: JsonObject = {};

vi.mock("@/lib/gatewayApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gatewayApi")>()),
  openGatewayApi: async (): Promise<GatewayApi> => ({
    gateway: "https://apps.example.com",
    call: async (name, args = {}) => {
      calls.push([name, args]);
      return answer;
    },
    list: async () => [],
  }),
}));

const workspace = await import(".");
const events = await import("../events");
const ai = await import("../ai");

const lines: string[] = [];
beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  answer = {};
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
});
afterEach(() => vi.restoreAllMocks());

const json = { json: true } as const;
const done = () => lines.map((line) => JSON.parse(line) as JsonObject).find((event) => event["type"] === "done");

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
