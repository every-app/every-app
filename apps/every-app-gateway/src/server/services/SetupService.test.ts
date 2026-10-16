import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasAnyOwnerMembership: vi.fn(),
  claimOwnerBootstrap: vi.fn(),
  releaseOwnerBootstrap: vi.fn(),
  clearStaleOwnerBootstrap: vi.fn(),
  findActiveClaims: vi.fn(),
  consume: vi.fn(),
  findById: vi.fn(),
  deleteById: vi.fn(),
  deleteUnaffiliatedByEmail: vi.fn(),
  markEmailVerified: vi.fn(),
  deleteOrganization: vi.fn(),
  signUpEmail: vi.fn(),
  createOrganization: vi.fn(),
  findAwaitingOwner: vi.fn(),
  adoptForOwner: vi.fn(),
  grantDefaultAppsToUser: vi.fn(),
  grantUnclaimedAppsToOwner: vi.fn(),
}));

const workerEnv = vi.hoisted(() => ({
  GATEWAY_DEPLOYMENT_MODE: "self_hosted" as string | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

vi.mock("@/auth", () => ({
  createAuth: () => ({
    api: {
      signUpEmail: mocks.signUpEmail,
      createOrganization: mocks.createOrganization,
    },
  }),
}));

vi.mock("@/server/organization/owner-membership", () => ({
  hasAnyOwnerMembership: mocks.hasAnyOwnerMembership,
  claimOwnerBootstrap: mocks.claimOwnerBootstrap,
  releaseOwnerBootstrap: mocks.releaseOwnerBootstrap,
  clearStaleOwnerBootstrap: mocks.clearStaleOwnerBootstrap,
}));

vi.mock("../repositories/OwnerSetupTokenRepository", () => ({
  OwnerSetupTokenRepository: {
    findActiveClaims: mocks.findActiveClaims,
    consume: mocks.consume,
  },
}));

vi.mock("../repositories/UserRepository", () => ({
  UserRepository: {
    findById: mocks.findById,
    deleteById: mocks.deleteById,
    deleteUnaffiliatedByEmail: mocks.deleteUnaffiliatedByEmail,
    markEmailVerified: mocks.markEmailVerified,
  },
}));

vi.mock("../repositories/OrganizationRepository", () => ({
  OrganizationRepository: {
    deleteById: mocks.deleteOrganization,
    findAwaitingOwner: mocks.findAwaitingOwner,
    adoptForOwner: mocks.adoptForOwner,
  },
}));

vi.mock("./AppAccessService", () => ({
  AppAccessService: {
    grantDefaultAppsToUser: mocks.grantDefaultAppsToUser,
    grantUnclaimedAppsToOwner: mocks.grantUnclaimedAppsToOwner,
  },
}));

import { hashSetupToken } from "../setup-token";
import { SetupError, SetupService } from "./SetupService";

const TOKEN = "est_valid-link-secret";

function claim(overrides: Partial<Record<string, string>> = {}) {
  return SetupService.claimOwner({
    token: TOKEN,
    name: "Ada Owner",
    email: "Ada@Example.com",
    password: "correct horse battery",
    ...overrides,
  });
}

describe("SetupService.claimOwner", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.findActiveClaims.mockResolvedValue([
      { id: "link-1", tokenHash: await hashSetupToken(TOKEN) },
    ]);
    mocks.hasAnyOwnerMembership.mockResolvedValue(false);
    mocks.clearStaleOwnerBootstrap.mockResolvedValue(null);
    mocks.claimOwnerBootstrap.mockResolvedValue(true);
    mocks.releaseOwnerBootstrap.mockResolvedValue(undefined);
    mocks.consume.mockResolvedValue(true);
    mocks.signUpEmail.mockResolvedValue({
      user: { id: "user-1", email: "ada@example.com", name: "Ada Owner" },
    });
    mocks.findById.mockResolvedValue({ id: "user-1" });
    mocks.createOrganization.mockResolvedValue({ id: "org-1" });
    mocks.findAwaitingOwner.mockResolvedValue(null);
    mocks.adoptForOwner.mockResolvedValue(undefined);
    mocks.grantDefaultAppsToUser.mockResolvedValue(undefined);
    mocks.grantUnclaimedAppsToOwner.mockResolvedValue(undefined);
  });

  it("creates the owner, their organization and consumes the link", async () => {
    await expect(claim()).resolves.toEqual({
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(mocks.signUpEmail).toHaveBeenCalledWith({
      body: {
        name: "Ada Owner",
        email: "ada@example.com",
        password: "correct horse battery",
      },
    });
    expect(mocks.createOrganization).toHaveBeenCalledWith({
      body: {
        name: "Ada Owner",
        slug: "ada-owner",
        userId: "user-1",
        status: "active",
      },
    });
    expect(mocks.adoptForOwner).not.toHaveBeenCalled();
    expect(mocks.grantUnclaimedAppsToOwner).toHaveBeenCalledWith(
      "user-1",
      "org-1",
    );
    expect(mocks.consume).toHaveBeenCalledWith("link-1", "user-1");
    expect(mocks.releaseOwnerBootstrap).not.toHaveBeenCalled();
    // Self-hosted accounts never need a verified email.
    expect(mocks.markEmailVerified).not.toHaveBeenCalled();
  });

  it("takes over the organization apps were deployed to before anyone existed", async () => {
    mocks.findAwaitingOwner.mockResolvedValue("org-ci");

    await expect(claim()).resolves.toEqual({
      userId: "user-1",
      organizationId: "org-ci",
    });

    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.adoptForOwner).toHaveBeenCalledWith("org-ci", {
      userId: "user-1",
      name: "Ada Owner",
    });
    // Their initial access found no members: the owner gets them all.
    expect(mocks.grantUnclaimedAppsToOwner).toHaveBeenCalledWith(
      "user-1",
      "org-ci",
    );
    expect(
      mocks.grantUnclaimedAppsToOwner.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.adoptForOwner.mock.invocationCallOrder[0]!);
  });

  it("keeps an adopted organization and its apps when the claim rolls back", async () => {
    mocks.findAwaitingOwner.mockResolvedValue("org-ci");
    mocks.consume.mockResolvedValue(false);

    await expect(claim()).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_SETUP_LINK",
    });
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
    // Its membership and grants go with the user.
    expect(mocks.deleteById).toHaveBeenCalledWith("user-1");
  });

  it("names the hosted gateway's install organization Every App: the platform organization", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    try {
      await expect(claim()).resolves.toEqual({
        userId: "user-1",
        organizationId: "org-1",
      });
      expect(mocks.signUpEmail).toHaveBeenCalledWith({
        body: expect.objectContaining({ name: "Ada Owner" }),
      });
      expect(mocks.createOrganization).toHaveBeenCalledWith({
        body: {
          name: "Every App",
          slug: "every-app",
          userId: "user-1",
          status: "active",
        },
      });
      // Hosted accounts sign in once verified; the setup link's owner is.
      expect(mocks.markEmailVerified).toHaveBeenCalledWith("user-1");
    } finally {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    }
  });

  it("refuses every claim, creating nothing, when the deployment mode is invalid", async () => {
    for (const mode of [undefined, "", "selfhosted"]) {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = mode;
      await expect(claim()).rejects.toMatchObject({
        code: "SETUP_UNAVAILABLE",
        status: 403,
      });
    }
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    expect(mocks.findActiveClaims).not.toHaveBeenCalled();
    expect(mocks.claimOwnerBootstrap).not.toHaveBeenCalled();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("rejects a wrong token with 403 and creates nothing", async () => {
    for (const token of ["est_wrong", "not-a-setup-token", ""]) {
      await expect(claim({ token })).rejects.toMatchObject({
        code: "INVALID_OR_EXPIRED_SETUP_LINK",
        status: 403,
      });
    }
    expect(mocks.claimOwnerBootstrap).not.toHaveBeenCalled();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("rejects a used or expired link with 403 (only live links are matched)", async () => {
    mocks.findActiveClaims.mockResolvedValue([]);

    await expect(claim()).rejects.toBeInstanceOf(SetupError);
    await expect(claim()).rejects.toMatchObject({ status: 403 });
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("refuses a valid link once the gateway has an owner", async () => {
    mocks.hasAnyOwnerMembership.mockResolvedValue(true);

    await expect(claim()).rejects.toMatchObject({
      code: "ALREADY_CLAIMED",
      status: 409,
    });
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent claims through", async () => {
    mocks.claimOwnerBootstrap
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const results = await Promise.allSettled([claim(), claim()]);

    // Either may win the bootstrap race; exactly one does, and the other is
    // told to retry (no owner exists yet).
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "CLAIM_IN_PROGRESS", status: 503 },
    });
    expect(mocks.signUpEmail).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("asks the retry of a claim killed part-way to wait, not to sign in", async () => {
    // The killed claim's bootstrap row is under two minutes old, so it is
    // not cleared yet, and it never produced an owner.
    mocks.claimOwnerBootstrap.mockResolvedValue(false);

    await expect(claim()).rejects.toMatchObject({
      code: "CLAIM_IN_PROGRESS",
      status: 503,
    });
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
    expect(mocks.releaseOwnerBootstrap).not.toHaveBeenCalled();
  });

  it("reports an owner once the claim holding the bootstrap made one", async () => {
    mocks.hasAnyOwnerMembership
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.claimOwnerBootstrap.mockResolvedValue(false);

    await expect(claim()).rejects.toMatchObject({
      code: "ALREADY_CLAIMED",
      status: 409,
    });
  });

  it("rolls back and leaves the link usable when a step fails", async () => {
    mocks.grantDefaultAppsToUser.mockRejectedValue(new Error("grant failed"));

    await expect(claim()).rejects.toThrow("grant failed");

    expect(mocks.deleteOrganization).toHaveBeenCalledWith("org-1");
    expect(mocks.deleteById).toHaveBeenCalledWith("user-1");
    expect(mocks.releaseOwnerBootstrap).toHaveBeenCalledOnce();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("rolls back if the link was consumed by another claim", async () => {
    mocks.consume.mockResolvedValue(false);

    await expect(claim()).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_SETUP_LINK",
    });
    expect(mocks.deleteById).toHaveBeenCalledWith("user-1");
    expect(mocks.releaseOwnerBootstrap).toHaveBeenCalledOnce();
  });

  it("rejects an email that already has an account", async () => {
    // Better Auth's duplicate-email sign-up returns a synthetic user that
    // was never written.
    mocks.findById.mockResolvedValue(undefined);

    await expect(claim()).rejects.toMatchObject({
      code: "USER_ALREADY_EXISTS",
    });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.deleteById).not.toHaveBeenCalled();
    expect(mocks.releaseOwnerBootstrap).toHaveBeenCalledOnce();
  });

  it("recovers from a claim that died part-way and left a stale bootstrap", async () => {
    const staleSince = new Date("2026-10-05T10:00:00Z");
    mocks.clearStaleOwnerBootstrap.mockResolvedValue(staleSince);

    await expect(claim()).resolves.toMatchObject({ userId: "user-1" });

    expect(mocks.deleteUnaffiliatedByEmail).toHaveBeenCalledWith(
      "ada@example.com",
      staleSince,
    );
    expect(
      mocks.deleteUnaffiliatedByEmail.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.claimOwnerBootstrap.mock.invocationCallOrder[0]!);
  });

  it("never logs the token, email or password", async () => {
    const log = vi.mocked(console.log);
    await claim();
    await claim({ token: "est_wrong" }).catch(() => undefined);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("setup.claimed");
    expect(output).toContain("setup.claim_rejected");
    expect(output).not.toMatch(/est_|ada@example|correct horse/i);
  });
});
