import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
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
vi.mock("@/server/services/GroupService", () => ({ GroupService: {} }));

import {
  createGroup,
  deleteGroup,
  getGroupApps,
  getGroupMembers,
  listGroups,
  setGroupApps,
  setGroupMembers,
  updateGroup,
} from "./groups";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
};

const serverFns = {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupMembers,
  setGroupMembers,
  getGroupApps,
  setGroupApps,
} as unknown as Record<string, ServerFnBuilder>;

describe("group server functions", () => {
  it.each(Object.keys(serverFns))(
    "%s is behind the public error and organization admin gate",
    (name) => {
      expect(serverFns[name]!.middlewares).toEqual([
        mocks.publicErrorMiddleware,
        mocks.organizationAdminMiddleware,
      ]);
    },
  );

  it("validates names, ids and lists", () => {
    const create = serverFns["createGroup"]!.validatorFn!;
    expect(create({ name: "  Sales  ", description: " team " })).toEqual({
      name: "Sales",
      description: "team",
    });
    expect(() => create({ name: "   " })).toThrow("Name is required");
    expect(() => create({ name: "x".repeat(61) })).toThrow("at most 60");

    const update = serverFns["updateGroup"]!.validatorFn!;
    expect(() => update({ id: "not-a-group", name: "Sales" })).toThrow(
      "Invalid group",
    );
    expect(update({ id: "grp_0123456789abcdef", name: "Sales" })).toEqual({
      id: "grp_0123456789abcdef",
      name: "Sales",
    });

    const setMembers = serverFns["setGroupMembers"]!.validatorFn!;
    expect(() =>
      setMembers({ id: "grp_0123456789abcdef", userIds: [""] }),
    ).toThrow("User ID is required");

    const setApps = serverFns["setGroupApps"]!.validatorFn!;
    expect(() =>
      setApps({ id: "grp_0123456789abcdef", appRowIds: ["todo"] }),
    ).toThrow("Invalid app ID");
    expect(
      setApps({
        id: "grp_0123456789abcdef",
        appRowIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).toEqual({
      id: "grp_0123456789abcdef",
      appRowIds: ["11111111-1111-4111-8111-111111111111"],
    });
  });
});
