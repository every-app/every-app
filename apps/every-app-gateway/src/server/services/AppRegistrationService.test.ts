import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("@/server/repositories/AppRepository", () => ({
  DELETED_APP_STATUS: "deleted",
  AppRepository: {
    findByAppSlug: vi.fn(),
    findByHostname: vi.fn(),
    findByWorkerName: vi.fn(),
    createWithInitialAccess: vi.fn(),
    restoreWithInitialAccess: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/server/repositories/OrganizationKeyRepository", () => ({
  OrganizationKeyRepository: {
    findByOrganizationId: vi.fn(),
    claim: vi.fn(),
  },
}));

vi.mock("@/server/repositories/OrganizationMembersRepository", () => ({
  OrganizationMembersRepository: {
    listMembersForOrganization: vi.fn(),
  },
}));

vi.mock("@/server/repositories/OrganizationRepository", () => ({
  OrganizationRepository: {
    findSlugById: vi.fn(),
  },
}));

import { AppRepository } from "@/server/repositories/AppRepository";
import { OrganizationKeyRepository } from "@/server/repositories/OrganizationKeyRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import {
  AppRegistrationService,
  orgKeyBaseFor,
} from "./AppRegistrationService";

const mockAppRepository = vi.mocked(AppRepository);
const mockOrgKeys = vi.mocked(OrganizationKeyRepository);
const mockMembersRepository = vi.mocked(OrganizationMembersRepository);
const mockOrganizationRepository = vi.mocked(OrganizationRepository);

const input = {
  organizationId: "org-1",
  appSlug: "todo",
  name: "Todo",
  description: "A todo app",
  manifest: { id: "todo", resources: { d1: ["DB"], kv: ["KV", "CACHE"] } },
};

const registeredTodo = {
  id: "app-row-1",
  organizationId: "org-1",
  appSlug: "todo",
  hostname: "todo-acme.gateway.example.com",
  workerName: "every-acme-todo",
  legacyNames: false,
  status: "active",
  manifest: JSON.stringify({ id: "todo" }),
  isDefault: false,
};

describe("AppRegistrationService.register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppRepository.findByAppSlug.mockResolvedValue(undefined);
    mockAppRepository.findByHostname.mockResolvedValue(undefined);
    mockAppRepository.findByWorkerName.mockResolvedValue(undefined);
    mockAppRepository.createWithInitialAccess.mockResolvedValue(undefined);
    mockAppRepository.update.mockResolvedValue(undefined);
    mockOrganizationRepository.findSlugById.mockResolvedValue("acme");
    mockOrgKeys.findByOrganizationId.mockResolvedValue("acme");
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([]);
  });

  it("registers a new app as pending, with the names the gateway assigns", async () => {
    const result = await AppRegistrationService.register(input);

    expect(result).toMatchObject({
      status: "pending",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
      legacyNames: false,
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo", CACHE: "every-acme-todo--cache" },
      },
      previousManifest: null,
      existingApp: false,
    });
    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: "every-acme-todo",
        status: "pending",
        manifest: JSON.stringify(input.manifest),
      }),
      [],
    );
  });

  it("makes a new app private: the deployer, owners and admins only", async () => {
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1", role: "owner" },
      { id: "admin-1", role: "admin" },
      { id: "deployer-1", role: "member" },
      { id: "member-1", role: "member" },
    ] as any);

    const result = await AppRegistrationService.register({
      ...input,
      deployerUserId: "deployer-1",
    });

    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        appSlug: "todo",
        isDefault: false,
      }),
      ["owner-1", "admin-1", "deployer-1"].map((userId) =>
        expect.objectContaining({
          organizationId: "org-1",
          userId,
          appRowId: expect.any(String),
          grantedBy: null,
        }),
      ),
    );
    const [createdApp, initialAccess] =
      mockAppRepository.createWithInitialAccess.mock.calls[0] ?? [];
    expect(
      initialAccess?.every((grant) => grant.appRowId === createdApp?.id),
    ).toBe(true);
    expect(result).toMatchObject({ defaultAccess: false, grantedUserCount: 3 });
  });

  it('grants every member and future members with access: "everyone"', async () => {
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1", role: "owner" },
      { id: "member-1", role: "member" },
    ] as any);

    const result = await AppRegistrationService.register({
      ...input,
      manifest: { id: "todo", access: "everyone" },
    });

    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true }),
      [
        expect.objectContaining({ userId: "owner-1" }),
        expect.objectContaining({ userId: "member-1" }),
      ],
    );
    expect(result).toMatchObject({ defaultAccess: true, grantedUserCount: 2 });
  });

  it("retries a failed atomic registration as a new app", async () => {
    mockAppRepository.createWithInitialAccess.mockRejectedValueOnce(
      new Error("simulated initial ACL insert failure"),
    );

    await expect(AppRegistrationService.register(input)).rejects.toThrow(
      "simulated initial ACL insert failure",
    );

    const retryResult = await AppRegistrationService.register(input);

    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledTimes(2);
    expect(retryResult).toMatchObject({
      status: "pending",
      existingApp: false,
    });
  });

  it("keeps a registered app's names, status and live manifest on redeploy", async () => {
    mockAppRepository.findByAppSlug.mockResolvedValue(registeredTodo as any);
    mockAppRepository.findByWorkerName.mockResolvedValue(registeredTodo as any);
    mockAppRepository.findByHostname.mockResolvedValue(registeredTodo as any);
    // The org's slug changed since: the hostname stays what it was.
    mockOrganizationRepository.findSlugById.mockResolvedValue("acme-renamed");

    const result = await AppRegistrationService.register(input);

    expect(mockAppRepository.update).toHaveBeenCalledWith("app-row-1", {
      organizationId: "org-1",
      name: "Todo",
      description: "A todo app",
      hostname: "todo-acme.gateway.example.com",
      workerName: "every-acme-todo",
    });
    expect(
      mockMembersRepository.listMembersForOrganization,
    ).not.toHaveBeenCalled();
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "active",
      hostname: "todo-acme.gateway.example.com",
      previousManifest: { id: "todo" },
      existingApp: true,
      defaultAccess: false,
      grantedUserCount: 0,
    });
  });

  it("keeps a legacy app on its every-<appId> Worker", async () => {
    const legacy = {
      ...registeredTodo,
      workerName: "every-todo",
      legacyNames: true,
    };
    mockAppRepository.findByAppSlug.mockResolvedValue(legacy as any);
    mockAppRepository.findByWorkerName.mockResolvedValue(legacy as any);

    const result = await AppRegistrationService.register({
      ...input,
      // An older CLI names the Worker itself; for a legacy app it matches.
      workerName: "every-todo",
    });

    expect(result).toMatchObject({
      workerName: "every-todo",
      legacyNames: true,
      // Legacy resources keep the single hyphen they were created with.
      resources: {
        d1: { DB: "every-todo" },
        kv: { CACHE: "every-todo-cache" },
      },
    });
    expect(mockOrgKeys.findByOrganizationId).not.toHaveBeenCalled();
  });

  it("refuses a new app id that holds the resource separator", async () => {
    await expect(
      AppRegistrationService.register({
        ...input,
        appSlug: "notes--archive",
        manifest: { id: "notes--archive" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_APP_ID" });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
  });

  it("refuses bindings that would share a database", async () => {
    await expect(
      AppRegistrationService.register({
        ...input,
        manifest: { id: "todo", resources: { d1: ["ARCHIVE", "Archive"] } },
      }),
    ).rejects.toMatchObject({ status: 400, code: "RESOURCE_NAME_CONFLICT" });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
  });

  it("refuses a Worker name an older CLI derived for a new app", async () => {
    await expect(
      AppRegistrationService.register({ ...input, workerName: "every-todo" }),
    ).rejects.toMatchObject({ status: 409, code: "WORKER_NAME_MISMATCH" });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
  });

  it("never names an app Worker after the gateway's own resources", async () => {
    mockOrgKeys.findByOrganizationId.mockResolvedValue("app");
    for (const appSlug of ["gateway", "gateway-deploy"]) {
      await expect(
        AppRegistrationService.register({
          ...input,
          appSlug,
          manifest: { id: appSlug },
        }),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_WORKER_NAME" });
    }
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
  });

  it("refuses an app id whose Worker name would be too long", async () => {
    const appSlug = "a".repeat(57);
    await expect(
      AppRegistrationService.register({
        ...input,
        appSlug,
        manifest: { id: appSlug },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_WORKER_NAME" });
  });

  it("restores a deleted app on redeploy by its own organization", async () => {
    const tombstone = { ...registeredTodo, status: "deleted" };
    mockAppRepository.findByAppSlug.mockResolvedValue(tombstone as any);
    mockAppRepository.findByWorkerName.mockResolvedValue(tombstone as any);
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1", role: "owner" },
    ] as any);

    const result = await AppRegistrationService.register(input);

    expect(mockAppRepository.restoreWithInitialAccess).toHaveBeenCalledWith(
      "app-row-1",
      expect.objectContaining({
        status: "pending",
        workerName: "every-acme-todo",
      }),
      [expect.objectContaining({ userId: "owner-1", appRowId: "app-row-1" })],
    );
    expect(mockAppRepository.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "pending",
      existingApp: true,
      grantedUserCount: 1,
    });
  });

  it("rejects a worker name already registered to another app", async () => {
    mockAppRepository.findByWorkerName.mockResolvedValue({
      organizationId: "org-2",
      appSlug: "acme-todo",
      status: "deleted",
    } as any);

    await expect(AppRegistrationService.register(input)).rejects.toMatchObject({
      status: 409,
      code: "WORKER_NAME_TAKEN",
    });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
    expect(mockAppRepository.update).not.toHaveBeenCalled();
  });

  it("maps a concurrent-registration unique-constraint failure to 409", async () => {
    mockAppRepository.createWithInitialAccess.mockRejectedValue(
      new Error("D1_ERROR: UNIQUE constraint failed: apps.hostname"),
    );

    await expect(AppRegistrationService.register(input)).rejects.toMatchObject({
      status: 409,
      code: "HOSTNAME_TAKEN",
    });
  });

  it("preserves hostname collision rejection", async () => {
    mockAppRepository.findByHostname.mockResolvedValue({
      organizationId: "org-2",
      appSlug: "another-app",
    } as any);

    await expect(AppRegistrationService.register(input)).rejects.toMatchObject({
      status: 409,
      code: "HOSTNAME_TAKEN",
    });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
  });
});

describe("organization keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppRepository.findByAppSlug.mockResolvedValue(undefined);
    mockAppRepository.findByHostname.mockResolvedValue(undefined);
    mockAppRepository.findByWorkerName.mockResolvedValue(undefined);
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([]);
    mockOrganizationRepository.findSlugById.mockResolvedValue(
      "acme-corporation",
    );
    mockOrgKeys.findByOrganizationId.mockResolvedValue(null);
  });

  it("keeps only up to 12 letters and digits of the slug", () => {
    expect(orgKeyBaseFor("acme-corporation")).toBe("acmecorporat");
    expect(orgKeyBaseFor("Default")).toBe("default");
    expect(orgKeyBaseFor("--")).toBe("org");
  });

  it("numbers a key another organization already holds", async () => {
    mockOrgKeys.claim
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("acmecorpora2");

    const result = await AppRegistrationService.register(input);

    expect(mockOrgKeys.claim.mock.calls.map(([, key]) => key)).toEqual([
      "acmecorporat",
      "acmecorpora2",
    ]);
    expect(result.workerName).toBe("every-acmecorpora2-todo");
  });
});
