import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  organizationMemberMiddleware: { name: "organizationMemberMiddleware" },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.middleware = vi.fn((middlewares: unknown[]) => {
      builder.middlewares = middlewares;
      return builder;
    });
    builder.validator = vi.fn((validator: (data: unknown) => unknown) => {
      builder.validatorFn = validator;
      return builder;
    });
    builder.handler = vi.fn((handler: (input: unknown) => unknown) => {
      builder.serverHandler = handler;
      return builder;
    });
    return builder;
  }),
}));
vi.mock("@/middleware/auth", () => ({
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
  organizationMemberMiddleware: mocks.organizationMemberMiddleware,
}));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/services/McpAppService", () => ({ McpAppService: {} }));

import {
  addRemoteMcpApp,
  getMcpApp,
  getMcpAppConnection,
  refreshMcpAppTools,
  removeMcpApp,
  setMcpAppStatus,
  updateRemoteMcpApp,
} from "./mcpApps";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
};

const fns = {
  addRemoteMcpApp,
  updateRemoteMcpApp,
  setMcpAppStatus,
  refreshMcpAppTools,
  getMcpApp,
  getMcpAppConnection,
  removeMcpApp,
} as unknown as Record<string, ServerFnBuilder>;

const ROW = "11111111-1111-4111-8111-111111111111";

describe("MCP app server functions", () => {
  it.each([
    "addRemoteMcpApp",
    "updateRemoteMcpApp",
    "setMcpAppStatus",
    "refreshMcpAppTools",
    "getMcpApp",
  ])("%s is behind the public error and organization admin gate", (name) => {
    expect(fns[name]!.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("getMcpAppConnection is any member's: their own connection status", () => {
    expect(fns["getMcpAppConnection"]!.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationMemberMiddleware,
    ]);
    expect(
      fns["getMcpAppConnection"]!.validatorFn!({ appId: " treg " }),
    ).toEqual({ appId: "treg" });
  });

  it("removeMcpApp is the owners' and admins', like the rest", () => {
    expect(fns["removeMcpApp"]!.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("reads an add as a URL, an optional id and name, a credential kind and a risk default", () => {
    const add = fns["addRemoteMcpApp"]!.validatorFn!;
    expect(
      add({
        url: "  https://treg.to/mcp/ ",
        id: " ",
        name: "",
        auth: { kind: "query", param: " api_key " },
        risk: "annotations",
      }),
    ).toEqual({
      url: "https://treg.to/mcp/",
      id: undefined,
      name: undefined,
      description: undefined,
      auth: {
        kind: "query",
        param: "api_key",
        header: undefined,
        provider: undefined,
        clientId: undefined,
        clientSecret: undefined,
      },
      risk: "annotations",
    });
    expect(
      add({
        url: "https://api.elevenlabs.io/v1/mcp",
        auth: { kind: "provider", provider: "elevenlabs" },
      }),
    ).toMatchObject({ auth: { kind: "provider", provider: "elevenlabs" } });
    // A field the schema doesn't know (a value where a name went) is refused.
    expect(() =>
      add({
        url: "https://treg.to/mcp",
        auth: { kind: "bearer", secret: "sk-live" },
      }),
    ).toThrow();
    expect(() => add({ url: "", auth: { kind: "none" } })).toThrow(
      "Give the server's URL",
    );
    expect(() =>
      add({ url: "https://treg.to/mcp", auth: { kind: "api-key" } }),
    ).toThrow();
    expect(() =>
      add({
        url: "https://treg.to/mcp",
        auth: { kind: "none" },
        risk: "destructive",
      }),
    ).toThrow();
  });

  it("reads an update's overrides by the server's tool names, and a status as active or disabled", () => {
    const update = fns["updateRemoteMcpApp"]!.validatorFn!;
    expect(
      update({
        id: ROW,
        tools: { getUser: { risk: "read", enabled: false } },
        tool: { name: "delete_everything", override: null },
      }),
    ).toEqual({
      id: ROW,
      tools: { getUser: { risk: "read", enabled: false } },
      tool: { name: "delete_everything", override: null },
    });
    expect(() =>
      update({ id: ROW, tools: { getUser: { risk: "admin" } } }),
    ).toThrow();
    expect(() =>
      update({ id: ROW, tools: { getUser: { value: "secret" } } }),
    ).toThrow();
    expect(() => update({ id: "treg", risk: "read" })).toThrow(
      "Invalid app ID",
    );

    const status = fns["setMcpAppStatus"]!.validatorFn!;
    expect(status({ id: ROW, status: "disabled" })).toEqual({
      id: ROW,
      status: "disabled",
    });
    expect(() => status({ id: ROW, status: "deleted" })).toThrow();
  });
});
