/**
 * The sign-in provider tools (signin.ts): two host-kind built-ins that read
 * Manage workspace → Sign-in for owners and admins, in either deployment
 * mode, and write nothing. A member never sees them (Unknown tool on call,
 * audited blocked), a credential narrowed to apps neither; a read-only
 * connection runs them (they read). There is no tool that adds or removes
 * a sign-in provider (threat model B10, `signin.tools.read-state-only`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_PROVIDER_IDS } from "@every-app/sdk/internal";
import { builtinToolKind, listBuiltinTools } from "./builtins";
import { createArgumentsDigester } from "./digest";
import { executeToolCall } from "./execute";
import { SIGNIN_TOOLS } from "./signin";
import {
  gatewayView,
  ISSUER,
  PRINCIPAL,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type {
  JsonObject,
  McpPrincipal,
  ToolBusDeps,
  ToolCallAuditEvent,
  WorkspaceHost,
} from "./types";

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

const MEMBER: McpPrincipal = { ...PRINCIPAL, orgRole: "member" };
const ADMIN: McpPrincipal = { ...PRINCIPAL, orgRole: "admin" };
const OWNER: McpPrincipal = { ...PRINCIPAL, orgRole: "owner" };
const readOnly = (principal: McpPrincipal): McpPrincipal => ({
  ...principal,
  access: "read",
});
const SIGNIN_NAMES = SIGNIN_TOOLS.map((tool) => `everyapp_${tool.name}`);

/** A host that records every call, registering providers or not. */
function harness(providers?: boolean) {
  const calls: { name: string; args: JsonObject; principal: McpPrincipal }[] =
    [];
  const events: ToolCallAuditEvent[] = [];
  const workspace: WorkspaceHost = {
    run: async (name, args, principal) => {
      calls.push({ name, args, principal });
      return {
        content: [{ type: "text", text: JSON.stringify({ name, args }) }],
        structuredContent: { name, args },
      };
    },
    ...(providers === undefined ? {} : { providers }),
  };
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async () => Response.json({}),
    workspace,
    audit: (event) => events.push(event),
    digestArguments: createArgumentsDigester("secret", "test"),
  };
  return { deps, calls, events };
}

describe("the sign-in provider tool definitions", () => {
  it("are a list and a show, both reads for owners and admins, needing nothing beyond a host; there is no add or remove", () => {
    expect(
      SIGNIN_TOOLS.map((tool) => [
        tool.name,
        tool.risk,
        tool.minRole,
        tool.needs ?? null,
        tool.irreversible ?? null,
      ]),
    ).toEqual([
      ["signin_list", "read", "admin", null, null],
      ["signin_show", "read", "admin", null, null],
    ]);
    for (const tool of SIGNIN_TOOLS) {
      expect(builtinToolKind(`everyapp_${tool.name}`)).toBe("host");
    }
    // No built-in of any kind writes a sign-in provider.
    const every = listBuiltinTools().map((tool) => tool.name);
    expect(every.filter((name) => /signin|sign_in/.test(name))).toEqual(
      SIGNIN_NAMES,
    );
  });

  it("keep the schemas closed: the list takes nothing, the show one catalog id", () => {
    const [list, show] = SIGNIN_TOOLS;
    expect(list!.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(show!.inputSchema).toEqual({
      type: "object",
      properties: {
        id: {
          type: "string",
          description: expect.any(String),
          enum: [...SIGN_IN_PROVIDER_IDS],
        },
      },
      required: ["id"],
      additionalProperties: false,
    });
  });
});

describe("listing the sign-in provider tools", () => {
  const names = (
    principal: McpPrincipal,
    host: { workspace?: boolean; providers?: boolean },
    listing: "full" | "compact" = "full",
  ) =>
    listBuiltinTools({ principal, listing }, host)
      .map((tool) => tool.name)
      .filter((name) => SIGNIN_NAMES.includes(name));

  it("lists them to owners and admins, read-only connections too, in both deployment modes; never to a member, a credential narrowed to apps, without a host or in compact mode", () => {
    for (const host of [
      { workspace: true, providers: true },
      { workspace: true },
    ]) {
      expect(names(OWNER, host)).toEqual(SIGNIN_NAMES);
      expect(names(ADMIN, host)).toEqual(SIGNIN_NAMES);
      expect(names(readOnly(ADMIN), host)).toEqual(SIGNIN_NAMES);
      expect(names(MEMBER, host)).toEqual([]);
      expect(names({ ...OWNER, appScope: "selected" }, host)).toEqual([]);
      expect(names(OWNER, host, "compact")).toEqual([]);
    }
    expect(names(OWNER, {})).toEqual([]);
  });
});

describe("running a sign-in provider tool", () => {
  it("runs for an admin on a read-only connection, through the read wrapper too, and answers a member Unknown tool, audited blocked", async () => {
    const { deps, calls, events } = harness();
    const shown = await executeToolCall(
      gatewayView([todoApp()], readOnly(ADMIN)),
      { name: "everyapp_signin_show", arguments: { id: "google" } },
      deps,
    );
    expect(shown.kind).toBe("result");
    expect(calls).toEqual([
      {
        name: "signin_show",
        args: { id: "google" },
        principal: readOnly(ADMIN),
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      tool: "everyapp_signin_show",
      appId: "everyapp",
      decision: "allowed",
      outcome: "ok",
    });

    const wrapped = await executeToolCall(
      gatewayView([todoApp()], readOnly(OWNER), undefined, "compact"),
      {
        name: "everyapp_call_read",
        arguments: { name: "everyapp_signin_list", arguments: {} },
      },
      deps,
    );
    expect(wrapped.kind).toBe("result");
    expect(calls.at(-1)).toMatchObject({ name: "signin_list", args: {} });
    expect(events.at(-1)).toMatchObject({
      tool: "everyapp_signin_list",
      via: "everyapp_call_read",
      decision: "allowed",
    });

    const before = calls.length;
    for (const name of SIGNIN_NAMES) {
      const refused = await executeToolCall(
        gatewayView([todoApp()], MEMBER),
        { name, arguments: name.endsWith("show") ? { id: "google" } : {} },
        deps,
      );
      expect(refused, name).toEqual({ kind: "unknown_tool" });
      expect(events.at(-1), name).toMatchObject({
        tool: name,
        decision: "blocked",
        reason: "role_required",
        outcome: "not_run",
      });
    }
    expect(calls).toHaveLength(before);
  });

  it("refuses an id the catalog doesn't have, or any other field, before the host is asked", async () => {
    const { deps, calls } = harness();
    for (const args of [
      {},
      { id: "okta" },
      { id: "google", value: true },
      { id: "google", clientSecret: "x" },
    ]) {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], OWNER),
        { name: "everyapp_signin_show", arguments: args as JsonObject },
        deps,
      );
      if (resolution.kind !== "result") throw new Error(resolution.kind);
      expect(resolution.result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
