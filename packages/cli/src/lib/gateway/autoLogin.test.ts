import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestHome } from "@/test/home";
import { GatewayApiError } from "./api";
import {
  checkSetupLink,
  describeOwnerLogin,
  setupLinkGone,
  waitForOwnerLogin,
} from "./autoLogin";
import { readGatewayCredential } from "./credentials";
import {
  listPendingClaims,
  readPendingClaim,
  writePendingClaim,
  type PendingClaim,
} from "./pendingClaims";

const CLAIM: PendingClaim = {
  gatewayUrl: "https://apps.example.com",
  url: "https://apps.example.com/setup#token=est_link",
  cliSecret: "ecs_secret",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

let home: string;

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  await writePendingClaim(CLAIM);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("pending claims", () => {
  it("keep the CLI's secret in a private file, and forget expired links", async () => {
    const file = path.join(home, ".everyapp", "pending-claims", "apps.example.com.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    await expect(readPendingClaim("apps.example.com")).resolves.toEqual(CLAIM);
    await expect(
      readPendingClaim("apps.example.com", Date.now() + 120_000),
    ).resolves.toBeNull();
    await expect(listPendingClaims()).resolves.toEqual([CLAIM]);
  });
});

describe("waitForOwnerLogin", () => {
  it("waits for the claim, stores the deploy token, and forgets the claim", async () => {
    const answers = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => ({ status: "pending" as const }),
      () => ({
        token: "eak_token",
        organizationId: "org-1",
        organizationName: "Acme",
        ownerEmail: "ada@example.com",
      }),
    ];
    const asked: string[] = [];
    const client = {
      setupDeployToken: async (secret: string) => {
        asked.push(secret);
        return answers.shift()!();
      },
    };

    await expect(waitForOwnerLogin({ claim: CLAIM, client, ...clock() })).resolves.toEqual({
      status: "logged_in",
      login: { organizationId: "org-1", organizationName: "Acme", ownerEmail: "ada@example.com" },
    });
    expect(asked).toEqual(["ecs_secret", "ecs_secret", "ecs_secret"]);
    await expect(readGatewayCredential(CLAIM.gatewayUrl)).resolves.toMatchObject({
      token: "eak_token",
      organizationId: "org-1",
    });
    await expect(listPendingClaims()).resolves.toEqual([]);
  });

  it("gives up after its time, leaving the claim to resume", async () => {
    const client = { setupDeployToken: async () => ({ status: "pending" as const }) };
    await expect(
      waitForOwnerLogin({ claim: CLAIM, client, timeoutMs: 10_000, ...clock() }),
    ).resolves.toEqual({ status: "waiting" });
    await expect(listPendingClaims()).resolves.toEqual([CLAIM]);
  });

  it("stops, forgetting the claim, once the gateway has no token for the link", async () => {
    const client = { setupDeployToken: async () => Promise.reject(gone()) };
    await expect(waitForOwnerLogin({ claim: CLAIM, client, ...clock() })).resolves.toEqual({
      status: "gone",
    });
    await expect(listPendingClaims()).resolves.toEqual([]);
  });
});

const gone = () =>
  new GatewayApiError({
    message: "This setup link is invalid, expired or already used.",
    status: 404,
    code: "INVALID_OR_EXPIRED_SETUP_LINK",
  });

describe("checkSetupLink", () => {
  it("asks once: waiting, also while the gateway can't be reached, or gone", async () => {
    const answers = [
      () => ({ status: "pending" as const }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw gone();
      },
    ];
    const client = { setupDeployToken: async () => answers.shift()!() };

    await expect(checkSetupLink({ claim: CLAIM, client })).resolves.toEqual({ status: "waiting" });
    await expect(checkSetupLink({ claim: CLAIM, client })).resolves.toEqual({ status: "waiting" });
    await expect(listPendingClaims()).resolves.toEqual([CLAIM]);
    await expect(checkSetupLink({ claim: CLAIM, client })).resolves.toEqual({ status: "gone" });
    await expect(listPendingClaims()).resolves.toEqual([]);
  });

  it("stops at once, keeping the claim, when Cloudflare Access answers instead", async () => {
    const accessInFront = new GatewayApiError({
      message: "Cloudflare Access answered /api/setup/deploy-token with its login page.",
      status: 302,
      code: "ACCESS_IN_FRONT",
    });
    const client = {
      setupDeployToken: async () => {
        throw accessInFront;
      },
    };
    await expect(checkSetupLink({ claim: CLAIM, client })).rejects.toBe(accessInFront);
    // Once the path is let through, `everyapp login --resume` finishes it.
    await expect(listPendingClaims()).resolves.toEqual([CLAIM]);
  });
});

describe("setupLinkGone", () => {
  it("says to sign in for a deploy token only once the gateway has its owner", () => {
    expect(setupLinkGone(CLAIM.gatewayUrl, true)).toMatchObject({
      code: "SETUP_LOGIN_EXPIRED",
      message: expect.stringContaining("Admin → Tokens"),
    });
    // Nobody can sign in yet: a new link is what it takes.
    const unclaimed = setupLinkGone(CLAIM.gatewayUrl, false);
    expect(unclaimed).toMatchObject({
      name: "ActionRequiredError",
      action: "claim_owner",
      message: expect.stringContaining("everyapp setup` again for a new link"),
    });
    expect(unclaimed.message).not.toContain("Admin → Tokens");
    expect(setupLinkGone(CLAIM.gatewayUrl, null)).toMatchObject({
      code: "SETUP_LOGIN_EXPIRED",
      message: expect.stringMatching(/Admin → Tokens.*again for a new link/s),
    });
  });
});

describe("describeOwnerLogin", () => {
  it("says who claimed the link, when the gateway says", () => {
    const login = { organizationId: "org-1", organizationName: "Acme", ownerEmail: "ada@example.com" };
    expect(describeOwnerLogin(CLAIM.gatewayUrl, login)).toBe(
      "Logged in to https://apps.example.com as ada@example.com (owner of Acme).",
    );
    // A gateway from before it said.
    expect(describeOwnerLogin(CLAIM.gatewayUrl, { ...login, ownerEmail: null })).toBe(
      "Logged in to https://apps.example.com for Acme.",
    );
  });
});
