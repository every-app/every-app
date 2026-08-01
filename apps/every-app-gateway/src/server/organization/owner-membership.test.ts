import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockWhere = vi.fn();
const mockOnConflictDoNothing = vi.fn(() => ({ returning: mockReturning }));
const mockValues = vi.fn(() => ({
  onConflictDoNothing: mockOnConflictDoNothing,
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      members: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: vi.fn(() => ({ values: mockValues })),
    delete: vi.fn(() => ({ where: mockWhere })),
  },
}));

vi.mock("@/db/schema", () => ({
  members: { role: "role" },
  ownerBootstrap: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

import {
  claimOwnerBootstrap,
  hasAnyOwnerMembership,
  releaseOwnerBootstrap,
} from "./owner-membership";

describe("owner membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue(undefined);
  });

  it("reports whether an owner membership exists", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "member-1" });
    await expect(hasAnyOwnerMembership()).resolves.toBe(true);

    mockFindFirst.mockResolvedValueOnce(undefined);
    await expect(hasAnyOwnerMembership()).resolves.toBe(false);
  });

  it("claims the singleton bootstrap row only when the insert wins", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "owner" }]);
    await expect(claimOwnerBootstrap()).resolves.toBe(true);

    mockReturning.mockResolvedValueOnce([]);
    await expect(claimOwnerBootstrap()).resolves.toBe(false);

    expect(mockOnConflictDoNothing).toHaveBeenCalledWith({ target: "id" });
  });

  it("releases a failed bootstrap claim", async () => {
    await releaseOwnerBootstrap();

    expect(mockWhere).toHaveBeenCalledWith({ column: "id", value: "owner" });
  });
});
