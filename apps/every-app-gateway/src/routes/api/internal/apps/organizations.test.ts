import { describe, expect, it, vi } from "vitest";

const { mockOrderBy, mockFrom, mockSelect } = vi.hoisted(() => {
  const orderBy = vi.fn();
  const from = vi.fn(() => ({
    orderBy,
  }));
  const select = vi.fn(() => ({
    from,
  }));

  return {
    mockOrderBy: orderBy,
    mockFrom: from,
    mockSelect: select,
  };
});

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/db", () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock("@/db/schema", () => ({
  organizations: {
    id: "id",
    name: "name",
    slug: "slug",
    createdAt: "createdAt",
  },
}));

import { Route } from "./organizations";

function getHandler() {
  return (Route as any).options.server.handlers.GET as () => Promise<Response>;
}

describe("/api/internal/apps/organizations", () => {
  it("returns organizations ordered by creation date", async () => {
    mockOrderBy.mockResolvedValue([
      { id: "org-1", name: "Default Organization", slug: "default" },
    ]);

    const response = await getHandler()();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizations: [
        { id: "org-1", name: "Default Organization", slug: "default" },
      ],
    });
  });
});
