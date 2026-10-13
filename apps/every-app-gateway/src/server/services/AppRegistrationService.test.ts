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
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { AppRegistrationService } from "./AppRegistrationService";

const mockAppRepository = vi.mocked(AppRepository);
const mockMembersRepository = vi.mocked(OrganizationMembersRepository);
const mockOrganizationRepository = vi.mocked(OrganizationRepository);

const input = {
  organizationId: "org-1",
  appSlug: "todo",
  name: "Todo",
  description: "A todo app",
  workerName: "every-todo",
  manifest: { id: "todo" },
};

describe("AppRegistrationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppRepository.findByAppSlug.mockResolvedValue(undefined);
    mockAppRepository.findByHostname.mockResolvedValue(undefined);
    mockAppRepository.findByWorkerName.mockResolvedValue(undefined);
    mockAppRepository.createWithInitialAccess.mockResolvedValue(undefined);
    mockAppRepository.update.mockResolvedValue(undefined);
    mockOrganizationRepository.findSlugById.mockResolvedValue("acme");
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
    expect(result).toMatchObject({
      hostname: "todo-acme.gateway.example.com",
      existingApp: false,
      defaultAccess: false,
      grantedUserCount: 3,
    });
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
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1", role: "owner" },
      { id: "member-1", role: "member" },
    ] as any);
    mockAppRepository.createWithInitialAccess.mockRejectedValueOnce(
      new Error("simulated initial ACL insert failure"),
    );

    await expect(AppRegistrationService.register(input)).rejects.toThrow(
      "simulated initial ACL insert failure",
    );

    const retryResult = await AppRegistrationService.register(input);

    expect(mockAppRepository.findByAppSlug).toHaveBeenCalledTimes(2);
    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledTimes(2);
    expect(retryResult).toMatchObject({
      existingApp: false,
      defaultAccess: false,
      grantedUserCount: 1,
    });
  });

  it("updates an old hostname on redeploy and leaves ACL/default access untouched", async () => {
    const existingApp = {
      id: "app-row-1",
      organizationId: "org-1",
      appSlug: "todo",
      isDefault: false,
    };
    mockAppRepository.findByAppSlug.mockResolvedValue(existingApp as any);

    const result = await AppRegistrationService.register(input);

    expect(mockAppRepository.update).toHaveBeenCalledWith("app-row-1", {
      organizationId: "org-1",
      name: "Todo",
      description: "A todo app",
      hostname: "todo-acme.gateway.example.com",
      workerName: "every-todo",
      manifest: JSON.stringify({ id: "todo" }),
      status: "active",
    });
    expect(
      mockMembersRepository.listMembersForOrganization,
    ).not.toHaveBeenCalled();
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      existingApp: true,
      defaultAccess: false,
      grantedUserCount: 0,
    });
  });

  it("rejects a worker name that is not the app's own Worker", async () => {
    for (const workerName of ["every-todo-globex", "billing-worker", "todo"]) {
      await expect(
        AppRegistrationService.register({ ...input, workerName }),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_WORKER_NAME" });
    }
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
    expect(mockAppRepository.update).not.toHaveBeenCalled();
  });

  it("rejects the gateway's own Worker", async () => {
    await expect(
      AppRegistrationService.register({
        ...input,
        appSlug: "app-gateway",
        workerName: "every-app-gateway",
        manifest: { id: "app-gateway" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_WORKER_NAME" });
  });

  it("rejects a second organization registering the same app id", async () => {
    mockOrganizationRepository.findSlugById.mockResolvedValue("globex");
    mockAppRepository.findByWorkerName.mockResolvedValue({
      organizationId: "org-1",
      appSlug: "todo",
      status: "active",
    } as any);

    await expect(
      AppRegistrationService.register({ ...input, organizationId: "org-2" }),
    ).rejects.toMatchObject({ status: 409, code: "WORKER_NAME_TAKEN" });
  });

  it("keeps a deleted app's id reserved to its organization", async () => {
    mockOrganizationRepository.findSlugById.mockResolvedValue("globex");
    mockAppRepository.findByWorkerName.mockResolvedValue({
      organizationId: "org-1",
      appSlug: "todo",
      status: "deleted",
    } as any);

    await expect(
      AppRegistrationService.register({ ...input, organizationId: "org-2" }),
    ).rejects.toMatchObject({ status: 409, code: "WORKER_NAME_TAKEN" });
  });

  it("restores a deleted app on redeploy by its own organization", async () => {
    const tombstone = {
      id: "app-row-1",
      organizationId: "org-1",
      appSlug: "todo",
      status: "deleted",
      isDefault: false,
    };
    mockAppRepository.findByAppSlug.mockResolvedValue(tombstone as any);
    mockAppRepository.findByWorkerName.mockResolvedValue(tombstone as any);
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1", role: "owner" },
    ] as any);

    const result = await AppRegistrationService.register(input);

    expect(mockAppRepository.restoreWithInitialAccess).toHaveBeenCalledWith(
      "app-row-1",
      expect.objectContaining({ status: "active" }),
      [expect.objectContaining({ userId: "owner-1", appRowId: "app-row-1" })],
    );
    expect(mockAppRepository.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ existingApp: true, grantedUserCount: 1 });
  });

  it("rejects a worker name already registered to another app", async () => {
    mockAppRepository.findByWorkerName.mockResolvedValue({
      organizationId: "org-2",
      appSlug: "todo",
    } as any);

    await expect(AppRegistrationService.register(input)).rejects.toMatchObject({
      status: 409,
      code: "WORKER_NAME_TAKEN",
    });
    expect(mockAppRepository.createWithInitialAccess).not.toHaveBeenCalled();
    expect(mockAppRepository.update).not.toHaveBeenCalled();
  });

  it("allows an app to keep its own worker name on redeploy", async () => {
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-1",
      organizationId: "org-1",
      appSlug: "todo",
      isDefault: false,
    } as any);
    mockAppRepository.findByWorkerName.mockResolvedValue({
      organizationId: "org-1",
      appSlug: "todo",
    } as any);

    const result = await AppRegistrationService.register(input);

    expect(result.existingApp).toBe(true);
    expect(mockAppRepository.update).toHaveBeenCalled();
  });

  it("maps a concurrent-registration unique-constraint failure to 409", async () => {
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([]);
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
