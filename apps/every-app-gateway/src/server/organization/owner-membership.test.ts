import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockBootstrapFindFirst = vi.fn();
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
      ownerBootstrap: {
        findFirst: (...args: unknown[]) => mockBootstrapFindFirst(...args),
      },
    },
    insert: vi.fn(() => ({ values: mockValues })),
    delete: vi.fn(() => ({ where: mockWhere })),
  },
}));

vi.mock("@/db/schema", () => ({
  members: { role: "role" },
  ownerBootstrap: { id: "id", claimedAt: "claimedAt" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

import {
  claimOwnerBootstrap,
  clearStaleOwnerBootstrap,
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

  it("clears a bootstrap claim only once it is two minutes old", async () => {
    const claimedAt = new Date(1_000_000);
    mockBootstrapFindFirst.mockResolvedValue({ id: "owner", claimedAt });

    await expect(clearStaleOwnerBootstrap(1_000_000 + 60_000)).resolves.toBe(
      null,
    );
    expect(mockWhere).not.toHaveBeenCalled();

    await expect(clearStaleOwnerBootstrap(1_000_000 + 121_000)).resolves.toBe(
      claimedAt,
    );
    expect(mockWhere).toHaveBeenCalledWith({
      and: [
        { column: "id", value: "owner" },
        { column: "claimedAt", value: claimedAt },
      ],
    });
  });

  it("does nothing without a bootstrap row", async () => {
    mockBootstrapFindFirst.mockResolvedValue(undefined);
    await expect(clearStaleOwnerBootstrap()).resolves.toBeNull();
  });
});
