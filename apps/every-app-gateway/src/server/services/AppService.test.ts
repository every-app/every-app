import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindAllWithAccessCounts = vi.fn();
const mockFindAllShared = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_DEPLOYMENT_MODE: "hosted" },
}));

vi.mock("../repositories/AppRepository", () => ({
  AppRepository: {
    findAllWithAccessCounts: (...args: unknown[]) =>
      mockFindAllWithAccessCounts(...args),
    findAllShared: (...args: unknown[]) => mockFindAllShared(...args),
  },
}));

import { AppService } from "./AppService";

const CTX = { orgId: "org-1", userId: "user-1" } as never;

/**
 * The columns an apps row carries, with the given manifest snapshot. The
 * own-apps query already names the slug `appId`; the shared one is raw.
 */
function row(appSlug: string, manifest: string | null) {
  return {
    id: `row-${appSlug}`,
    organizationId: "org-1",
    name: appSlug,
    description: "",
    hostname: `${appSlug}.example.com`,
    workerName: `ea-${appSlug}`,
    tier: "dispatch",
    scope: "org",
    manifest,
    emailSenders: null,
    emailInbound: null,
    status: "active",
    deployedByActor: null,
    isDefault: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("AppService.getAllWithAccessCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summarises the capabilities of the organization's own apps and of shared ones", async () => {
    mockFindAllWithAccessCounts.mockResolvedValue([
      {
        ...row(
          "crm",
          JSON.stringify({
            id: "crm",
            capabilities: {
              "google-workspace": { access: "write", scopes: ["gmail.read"] },
            },
          }),
        ),
        appId: "crm",
        accessCount: 2,
      },
    ]);
    mockFindAllShared.mockResolvedValue([
      {
        ...row(
          "seo",
          JSON.stringify({
            id: "seo",
            capabilities: { dataforseo: { access: "read", why: "Ranks" } },
          }),
        ),
        appSlug: "seo",
        organizationId: "org-platform",
        scope: "shared",
      },
    ]);

    const { apps } = await AppService.getAllWithAccessCounts(CTX);

    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({
      appId: "crm",
      readOnly: false,
      accessCount: 2,
      capabilities: [
        {
          id: "google-workspace",
          scopeSets: [{ name: "gmail.read", label: "Gmail (read-only)" }],
          scopesStatus: "ok",
        },
      ],
    });
    expect(apps[1]).toMatchObject({
      appId: "seo",
      readOnly: true,
      accessCount: 0,
      capabilities: [{ id: "dataforseo", why: "Ranks", scopesStatus: "none" }],
    });
  });

  it("lists no capabilities for an app whose manifest is unreadable", async () => {
    mockFindAllWithAccessCounts.mockResolvedValue([
      { ...row("old", null), appId: "old", accessCount: 0 },
    ]);
    mockFindAllShared.mockResolvedValue([]);

    const { apps } = await AppService.getAllWithAccessCounts(CTX);

    expect(apps.map((app) => app.capabilities)).toEqual([[]]);
  });
});
