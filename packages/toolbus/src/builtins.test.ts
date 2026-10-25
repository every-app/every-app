import { describe, expect, it } from "vitest";
import {
  BUILTIN_APP_ID,
  builtinToolKind,
  findBuiltinTool,
  listBuiltinTools,
  runBuiltinTool,
} from "./builtins";
import {
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  splitNamespacedToolName,
} from "./names";
import { PRINCIPAL, todoApp } from "./test-fixtures";
import { gatewaySurfaceView } from "./view";
import { PROVIDER_TOOLS } from "./providers";
import { WORKSPACE_TOOLS } from "./workspace";

const READ_ONLY = { ...PRINCIPAL, access: "read" as const };

/** The five core built-ins, in listing order. */
const CORE = [
  "everyapp_list_apps",
  "everyapp_whoami",
  "everyapp_search_tools",
  "everyapp_call_read",
  "everyapp_call_write",
];

describe("the built-in tools", () => {
  const every = listBuiltinTools().map((tool) => tool.name);

  it("are the five core ones (three answered from the view, two wrappers), then every workspace tool, then the provider tools", () => {
    expect(every.slice(0, CORE.length)).toEqual(CORE);
    expect(every.slice(CORE.length)).toEqual(
      [...WORKSPACE_TOOLS, ...PROVIDER_TOOLS].map(
        (tool) => `everyapp_${tool.name}`,
      ),
    );
    for (const name of every) {
      expect(builtinToolKind(name), name).toBe(
        CORE.includes(name)
          ? name.startsWith("everyapp_call_")
            ? "wrapper"
            : "answer"
          : "host",
      );
    }
    expect(builtinToolKind("todo_list_todos")).toBeNull();
    expect(builtinToolKind("everyapp_nope")).toBeNull();
  });

  it("are listed per mode: the wrappers only in compact, the write wrapper only to write callers", () => {
    const names = (view: Parameters<typeof listBuiltinTools>[0]) =>
      listBuiltinTools(view).map((tool) => tool.name);
    expect(names({ principal: PRINCIPAL, listing: "full" })).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
    ]);
    // No mode on the view reads as full.
    expect(names({ principal: PRINCIPAL })).toEqual(
      names({ principal: PRINCIPAL, listing: "full" }),
    );
    // The workspace tools are a host's to list (workspace.test.ts).
    expect(names({ principal: PRINCIPAL, listing: "compact" })).toEqual(CORE);
    expect(names({ principal: READ_ONLY, listing: "compact" })).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "everyapp_call_read",
    ]);
    expect(names({ principal: READ_ONLY, listing: "full" })).toEqual(
      names({ principal: PRINCIPAL, listing: "full" }),
    );
  });

  it("are marked to load ahead of Claude Code's tool search, whichever mode lists them", () => {
    for (const listing of ["full", "compact"] as const) {
      const tools = listBuiltinTools({ principal: PRINCIPAL, listing });
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool._meta, tool.name).toEqual({ "anthropic/alwaysLoad": true });
      }
    }
  });

  it("spell out their hints: read-only but the write ones, destructive only for a workspace tool that asks confirm, never open-world", () => {
    for (const tool of listBuiltinTools()) {
      const definition = [...WORKSPACE_TOOLS, ...PROVIDER_TOOLS].find(
        (candidate) => `everyapp_${candidate.name}` === tool.name,
      );
      expect(tool.annotations, tool.name).toEqual(
        tool.name === "everyapp_call_write" || definition?.risk === "write"
          ? {
              readOnlyHint: false,
              destructiveHint: definition?.irreversible === true,
              idempotentHint: false,
              openWorldHint: false,
            }
          : { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      );
    }
  });

  it("take no arguments but the search and the wrappers, whose schemas are closed", () => {
    const schema = (name: string) =>
      listBuiltinTools().find((tool) => tool.name === name)!.inputSchema;
    for (const name of ["everyapp_list_apps", "everyapp_whoami"]) {
      expect(schema(name), name).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }
    expect(schema("everyapp_search_tools")).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        app: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      additionalProperties: false,
    });
    for (const name of ["everyapp_call_read", "everyapp_call_write"]) {
      expect(schema(name), name).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 128 },
          arguments: { type: "object" },
        },
        required: ["name"],
        additionalProperties: false,
      });
    }
  });

  it("are each listed as everyapp_<name>, within the namespaced name limit", () => {
    expect(every.length).toBeGreaterThan(0);
    for (const name of every) {
      const split = splitNamespacedToolName(name);
      expect(split?.appId, name).toBe(BUILTIN_APP_ID);
      const builtin = findBuiltinTool(split!.localName);
      expect(builtin?.name, name).toBe(split!.localName);
      expect(namespacedToolName(BUILTIN_APP_ID, builtin!.name)).toBe(name);
      expect(name.length, name).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    }
  });

  it("are the only everyapp_ tools the gateway's instructions name, and only those the caller is listed, in either mode", () => {
    // Apps without guidance of their own, so every everyapp_ name in the
    // text is the gateway's: it must not send a client to a tool that
    // doesn't exist, nor to one its own tools/list doesn't have (the write
    // wrapper is hidden from a read-only caller). The name grammar is
    // names.ts's.
    for (const listing of ["full", "compact"] as const) {
      for (const [access, principal] of [
        ["read & write", PRINCIPAL],
        ["read only", READ_ONLY],
      ] as const) {
        const { instructions } = gatewaySurfaceView(
          { ...principal, organizationName: "Acme" },
          [todoApp({ instructions: undefined })],
          {
            listing,
            unavailable: [{ appId: "crm", name: "CRM", reason: "needs setup" }],
          },
        );
        const named = [
          ...new Set(instructions!.match(/everyapp_[A-Za-z0-9_-]+/g) ?? []),
        ];
        expect(named.length, `${listing} ${access}`).toBeGreaterThan(0);
        const listed = listBuiltinTools({ principal, listing }).map(
          (tool) => tool.name,
        );
        const unlisted = named.filter((name) => !listed.includes(name));
        expect(
          unlisted,
          `${listing}, ${access}: the gateway's instructions name a built-in this caller's tools/list doesn't have`,
        ).toEqual([]);
      }
    }
    // The compact head sends a read-only caller to the read wrapper alone.
    const head = (principal: typeof PRINCIPAL) =>
      gatewaySurfaceView(principal, [todoApp()], {
        listing: "compact",
      }).instructions!.split("\n")[0]!;
    expect(head(PRINCIPAL)).toContain(
      "then everyapp_call_read or everyapp_call_write with a tool's name and arguments.",
    );
    expect(head(READ_ONLY)).toContain(
      "then everyapp_call_read with a tool's name and arguments (this connection is read only).",
    );
    expect(head(READ_ONLY)).not.toContain("everyapp_call_write");
  });
});

describe("everyapp_search_tools's own bounds", () => {
  const search = findBuiltinTool("search_tools")!;
  if (search.kind !== "answer") throw new Error("search_tools is a wrapper");
  const run = (args: Record<string, unknown>) =>
    runBuiltinTool(search, gatewaySurfaceView(PRINCIPAL, [todoApp()]), args);

  it("hold whatever checked the arguments before it: the query, the app id, the limit, and no other field", () => {
    // executeToolCall validates against the schema first; the search reads
    // its fields to the same bounds itself, so a schema check skipped or
    // wrong can't widen what it runs over.
    const problem = (args: Record<string, unknown>) => {
      const answer = run(args);
      return "problem" in answer ? answer.problem : null;
    };
    expect(problem({ query: "x".repeat(201) })).toBe(
      "query must be a string of 1 to 200 characters.",
    );
    expect(problem({ query: "" })).toBe(
      "query must be a string of 1 to 200 characters.",
    );
    expect(problem({ query: 1 })).toBe(
      "query must be a string of 1 to 200 characters.",
    );
    expect(problem({ app: "x".repeat(65) })).toBe(
      "app must be a string of 1 to 64 characters.",
    );
    for (const limit of [0, 26, 1e9, -5, 2.5, "10", null]) {
      expect(problem({ query: "todo", limit }), String(limit)).toBe(
        "limit must be an integer from 1 to 25.",
      );
    }
    expect(problem({ query: "todo", extra: 1 })).toBe(
      "`extra` is not one of query, app, limit.",
    );
    expect(problem({ query: "todo", pad: new Array(1000).fill(0) })).toBe(
      "`pad` is not one of query, app, limit.",
    );
    expect(problem({})).toBe("give a query, an app id, or both.");
    expect(problem({ query: "x".repeat(200), limit: 25 })).toBeNull();
    expect(problem({ app: "x".repeat(64) })).toBeNull();
  });
});
