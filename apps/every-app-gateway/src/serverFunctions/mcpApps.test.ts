import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  organizationOwnerMiddleware: { name: "organizationOwnerMiddleware" },
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
  organizationOwnerMiddleware: mocks.organizationOwnerMiddleware,
}));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/services/McpAppService", () => ({ McpAppService: {} }));

import {
  addRemoteMcpApp,
  getMcpApp,
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

  it("removeMcpApp is the owners'", () => {
    expect(fns["removeMcpApp"]!.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationOwnerMiddleware,
    ]);
  });

  it("reads an add as a URL, an optional id and name, an auth kind and a risk default", () => {
    const add = fns["addRemoteMcpApp"]!.validatorFn!;
    expect(
      add({
        url: "  https://treg.to/mcp/ ",
        id: " ",
        name: "",
        auth: { kind: "bearer", secret: " TREG_MCP_TOKEN " },
        risk: "annotations",
      }),
    ).toEqual({
      url: "https://treg.to/mcp/",
      id: undefined,
      name: undefined,
      description: undefined,
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN", header: undefined },
      risk: "annotations",
    });
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
