import { beforeEach, describe, expect, it, vi } from "vitest";

const { appsTable, userAppAccessTable, mockBatch, mockInsert } = vi.hoisted(
  () => {
    const appsTable = { table: "apps" };
    const userAppAccessTable = {
      table: "user_app_access",
      organizationId: "organization_id",
      userId: "user_id",
      appRowId: "app_row_id",
    };
    const mockBatch = vi.fn();
    const mockInsert = vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const statement = {
          table,
          values,
          onConflictDoNothing: vi.fn(),
        };
        statement.onConflictDoNothing.mockReturnValue(statement);
        return statement;
      },
    }));

    return { appsTable, userAppAccessTable, mockBatch, mockInsert };
  },
);

vi.mock("@/db", () => ({
  db: {
    batch: mockBatch,
    insert: mockInsert,
  },
}));

vi.mock("@/db/schema", () => ({
  apps: appsTable,
  userAppAccess: userAppAccessTable,
}));

import { AppRepository } from "./AppRepository";

type MockStatement = {
  table: unknown;
  values: Record<string, unknown>;
};

describe("AppRepository.createWithInitialAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rolls back the app when a grant fails and lets the retry create everything", async () => {
    const appRows: Array<Record<string, unknown>> = [];
    const accessRows: Array<Record<string, unknown>> = [];
    let failBeforeFirstGrant = true;

    mockBatch.mockImplementation(async (statements: MockStatement[]) => {
      const stagedApps = [...appRows];
      const stagedAccess = [...accessRows];

      for (const statement of statements) {
        if (statement.table === appsTable) {
          stagedApps.push(statement.values);
          continue;
        }

        if (failBeforeFirstGrant) {
          failBeforeFirstGrant = false;
          throw new Error("simulated initial ACL insert failure");
        }
        stagedAccess.push(statement.values);
      }

      appRows.splice(0, appRows.length, ...stagedApps);
      accessRows.splice(0, accessRows.length, ...stagedAccess);
    });

    const app = {
      id: "app-row-1",
      organizationId: "org-1",
      appSlug: "todo",
      name: "Todo",
      description: "A todo app",
      hostname: "todo-acme.gateway.example.com",
      workerName: "every-todo",
      manifest: JSON.stringify({ id: "todo" }),
      tier: "service_binding",
      status: "active",
      isDefault: true,
    };
    const grants = ["owner-1", "member-1"].map((userId) => ({
      id: `access-${userId}`,
      organizationId: "org-1",
      userId,
      appRowId: "app-row-1",
      grantedBy: null,
    }));

    await expect(
      AppRepository.createWithInitialAccess(app, grants),
    ).rejects.toThrow("simulated initial ACL insert failure");
    expect(appRows).toEqual([]);
    expect(accessRows).toEqual([]);

    await AppRepository.createWithInitialAccess(app, grants);

    expect(appRows).toEqual([expect.objectContaining({ id: "app-row-1" })]);
    expect(accessRows).toEqual([
      expect.objectContaining({ userId: "owner-1", appRowId: "app-row-1" }),
      expect.objectContaining({ userId: "member-1", appRowId: "app-row-1" }),
    ]);
    expect(mockBatch).toHaveBeenCalledTimes(2);
    expect(mockBatch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(mockBatch.mock.calls[1]?.[0]).toHaveLength(3);
  });
});
