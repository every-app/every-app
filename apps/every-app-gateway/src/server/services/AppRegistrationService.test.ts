import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: {
    findByAppSlug: vi.fn(),
    findByHostname: vi.fn(),
    findByWorkerName: vi.fn(),
    createWithInitialAccess: vi.fn(),
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

  it("makes a new app default and grants every current org member", async () => {
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1" },
      { id: "member-1" },
    ] as any);

    const result = await AppRegistrationService.register(input);

    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        appSlug: "todo",
        isDefault: true,
      }),
      [
        expect.objectContaining({
          organizationId: "org-1",
          userId: "owner-1",
          appRowId: expect.any(String),
          grantedBy: null,
        }),
        expect.objectContaining({
          organizationId: "org-1",
          userId: "member-1",
          appRowId: expect.any(String),
          grantedBy: null,
        }),
      ],
    );
    const [createdApp, initialAccess] =
      mockAppRepository.createWithInitialAccess.mock.calls[0] ?? [];
    expect(
      initialAccess?.every((grant) => grant.appRowId === createdApp?.id),
    ).toBe(true);
    expect(result).toMatchObject({
      hostname: "todo-acme.gateway.example.com",
      existingApp: false,
      defaultAccess: true,
      grantedUserCount: 2,
    });
  });

  it("retries a failed atomic registration as a new app", async () => {
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([
      { id: "owner-1" },
      { id: "member-1" },
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
      defaultAccess: true,
      grantedUserCount: 2,
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

  it("lets two organizations register the same app slug under distinct worker names", async () => {
    mockOrganizationRepository.findSlugById.mockImplementation(
      async (organizationId) =>
        organizationId === "org-1" ? "acme" : "globex",
    );
    mockMembersRepository.listMembersForOrganization.mockResolvedValue([]);

    const acme = await AppRegistrationService.register(input);
    const globex = await AppRegistrationService.register({
      ...input,
      organizationId: "org-2",
      workerName: "every-todo-globex",
    });

    expect(acme.hostname).toBe("todo-acme.gateway.example.com");
    expect(globex.hostname).toBe("todo-globex.gateway.example.com");
    expect(mockAppRepository.findByHostname).toHaveBeenNthCalledWith(
      1,
      "todo-acme.gateway.example.com",
    );
    expect(mockAppRepository.findByHostname).toHaveBeenNthCalledWith(
      2,
      "todo-globex.gateway.example.com",
    );
    expect(mockAppRepository.createWithInitialAccess).toHaveBeenCalledTimes(2);
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
