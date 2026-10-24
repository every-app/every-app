import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  listForOrganization: vi.fn(),
  listAppsWithCalls: vi.fn(),
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
}));

vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));

vi.mock("@/server/repositories/McpToolCallRepository", () => ({
  McpToolCallRepository: {
    listForOrganization: (...args: unknown[]) =>
      mocks.listForOrganization(...args),
    listAppsWithCalls: (...args: unknown[]) => mocks.listAppsWithCalls(...args),
  },
  TOOL_CALL_PAGE_MAX: 200,
}));

import { listToolCallApps, listToolCalls } from "./activity";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn: (data: unknown) => Record<string, unknown>;
  serverHandler: (input: {
    data: Record<string, unknown>;
    context: { org: Record<string, unknown> };
  }) => Promise<unknown>;
};

const listToolCallsServerFn = listToolCalls as unknown as ServerFnBuilder;
const listToolCallAppsServerFn = listToolCallApps as unknown as ServerFnBuilder;

describe("listToolCalls server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listForOrganization.mockResolvedValue({
      calls: [],
      nextBefore: null,
    });
  });

  it("is a read behind the public error and organization admin gate", () => {
    // A member who is not an owner or admin is refused by the middleware
    // before the handler runs; the methods test keeps it a GET.
    expect(listToolCallsServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("takes no filters at all, and fills in the page size", () => {
    expect(listToolCallsServerFn.validatorFn(undefined)).toEqual({
      limit: 50,
    });
    expect(listToolCallsServerFn.validatorFn({})).toEqual({ limit: 50 });
  });

  it("accepts every filter and the cursor", () => {
    expect(
      listToolCallsServerFn.validatorFn({
        before: { createdAt: 1_761_220_800_000, id: "call-1" },
        limit: 200,
        appRowId: "app-1",
        userId: "user-1",
        decision: "blocked",
        risk: "destructive",
        since: 1_761_134_400_000,
      }),
    ).toEqual({
      before: { createdAt: 1_761_220_800_000, id: "call-1" },
      limit: 200,
      appRowId: "app-1",
      userId: "user-1",
      decision: "blocked",
      risk: "destructive",
      since: 1_761_134_400_000,
    });
  });

  it("refuses a page size outside 1..200, an unknown decision or risk, and a malformed cursor", () => {
    const refuse = (data: unknown) =>
      expect(() => listToolCallsServerFn.validatorFn(data)).toThrow();
    refuse({ limit: 0 });
    refuse({ limit: 201 });
    refuse({ limit: 2.5 });
    refuse({ decision: "maybe" });
    refuse({ risk: "catastrophic" });
    refuse({ since: -1 });
    refuse({ before: { createdAt: "yesterday", id: "call-1" } });
    refuse({ before: { createdAt: 1, id: "" } });
  });

  it("refuses a time past what a Date can hold, which would bind NaN", () => {
    // Number.isInteger(1e20) is true, but new Date(1e20) is an Invalid Date.
    const refuse = (data: unknown) =>
      expect(() => listToolCallsServerFn.validatorFn(data)).toThrow();
    refuse({ since: 1e20 });
    refuse({ since: 8_640_000_000_000_001 });
    refuse({ before: { createdAt: 1e20, id: "call-1" } });
    expect(
      listToolCallsServerFn.validatorFn({ since: 8_640_000_000_000_000 }),
    ).toEqual({ limit: 50, since: 8_640_000_000_000_000 });
  });

  it("drops an organization named in the input: the active one is used", () => {
    expect(
      listToolCallsServerFn.validatorFn({ organizationId: "org-other" }),
    ).toEqual({ limit: 50 });
  });

  it("lists the active organization's calls with the validated filters", async () => {
    const org = { orgId: "org-1", userId: "admin-1", role: "admin" };
    await expect(
      listToolCallsServerFn.serverHandler({
        data: {
          limit: 25,
          before: { createdAt: 1_761_220_800_000, id: "call-9" },
          appRowId: "app-1",
          decision: "allowed",
          since: 1_761_134_400_000,
        },
        context: { org },
      }),
    ).resolves.toEqual({ calls: [], nextBefore: null });
    expect(mocks.listForOrganization).toHaveBeenCalledWith({
      organizationId: "org-1",
      limit: 25,
      before: { createdAt: 1_761_220_800_000, id: "call-9" },
      appRowId: "app-1",
      userId: undefined,
      decision: "allowed",
      risk: undefined,
      since: new Date(1_761_134_400_000),
    });
  });
});

describe("listToolCallApps server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a read behind the public error and organization admin gate", () => {
    expect(listToolCallAppsServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("lists the apps the active organization's calls name", async () => {
    const listed = [
      { rowId: "app-1", slug: "one", name: "One", removed: false },
    ];
    mocks.listAppsWithCalls.mockResolvedValue(listed);
    await expect(
      listToolCallAppsServerFn.serverHandler({
        data: {},
        context: { org: { orgId: "org-1", userId: "admin-1", role: "admin" } },
      }),
    ).resolves.toEqual(listed);
    expect(mocks.listAppsWithCalls).toHaveBeenCalledWith("org-1");
  });
});
