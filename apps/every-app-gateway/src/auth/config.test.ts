import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerEnv = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "test-secret",
  DB: {},
  GATEWAY_URL: "https://gateway.example.com",
}));

const captured = vi.hoisted(() => ({
  authOptions: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

vi.mock("better-auth", () => ({
  betterAuth: (options: unknown) => {
    captured.authOptions = options;
    return { options };
  },
}));

vi.mock("better-auth/api", () => ({
  APIError: class APIError extends Error {},
  createAuthMiddleware: (middleware: unknown) => middleware,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: () => ({ adapter: "test" }),
}));

vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  organization: (options: unknown) => ({ id: "organization", options }),
}));

vi.mock("drizzle-orm/d1", () => ({
  drizzle: () => ({ database: "test" }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock("./shared", () => ({
  sharedAuthOptions: {
    emailAndPassword: { enabled: true },
    plugins: [],
  },
}));

vi.mock("@/db", () => ({
  db: {
    query: { invitations: { findFirst: vi.fn() } },
  },
  schema: {},
}));

vi.mock("@/db/schema", () => ({
  invitations: { id: "id" },
}));

vi.mock("@/server/repositories/AppAccessRepository", () => ({
  AppAccessRepository: { deleteByOrganizationAndUser: vi.fn() },
}));

vi.mock("@/server/organization/owner-membership", () => ({
  hasAnyOwnerMembership: vi.fn(),
}));

vi.mock("@/server/services/AppAccessService", () => ({
  AppAccessService: { grantDefaultAppsToUser: vi.fn() },
}));

import { createAuth } from "./config";

type AuthOptions = {
  emailAndPassword: {
    sendResetPassword: (input: {
      user: { email: string };
      url: string;
    }) => Promise<void>;
  };
};

describe("createAuth email configuration", () => {
  beforeEach(() => {
    captured.authOptions = undefined;
    vi.restoreAllMocks();
  });

  it("initializes auth without the email binding and fails only on send", async () => {
    expect(() => createAuth()).not.toThrow();

    const options = captured.authOptions as AuthOptions;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      options.emailAndPassword.sendResetPassword({
        user: { email: "user@example.net" },
        url: "https://gateway.example.com/reset-password?token=test",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_BINDING_UNAVAILABLE",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Email delivery failed",
      expect.objectContaining({
        event: "email.send.failed",
        code: "EMAIL_BINDING_UNAVAILABLE",
      }),
    );
  });
});

type CapturedOptions = {
  baseURL?: string;
  rateLimit?: { enabled?: boolean };
  advanced?: {
    useSecureCookies?: boolean;
    ipAddress?: unknown;
    crossSubDomainCookies?: unknown;
  };
  plugins: { id: string }[];
};

function createAuthOptions(): CapturedOptions {
  createAuth();
  return captured.authOptions as CapturedOptions;
}

describe("createAuth Better Auth options", () => {
  const gatewayUrl = workerEnv.GATEWAY_URL;

  afterEach(() => {
    vi.unstubAllEnvs();
    workerEnv.GATEWAY_URL = gatewayUrl;
  });

  it("pins the base URL to the gateway and reads the client IP from Cloudflare", () => {
    const options = createAuthOptions();

    expect(options.baseURL).toBe("https://gateway.example.com");
    expect(options.advanced?.ipAddress).toEqual({
      ipAddressHeaders: ["cf-connecting-ip"],
    });
  });

  // Better Auth 1.7 reads NODE_ENV at runtime, which the deployed Worker
  // never sets, so these must not be left to its defaults.
  it("enables rate limiting, secure cookies and app-subdomain cookies in production builds", () => {
    vi.stubEnv("DEV", false);

    expect(createAuthOptions()).toMatchObject({
      rateLimit: { enabled: true },
      advanced: {
        useSecureCookies: true,
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
        crossSubDomainCookies: {
          enabled: true,
          domain: "gateway.example.com",
        },
      },
    });
  });

  it("disables rate limiting and secure cookies under vite dev", () => {
    vi.stubEnv("DEV", true);

    const options = createAuthOptions();
    expect(options.rateLimit).toEqual({ enabled: false });
    expect(options.advanced?.useSecureCookies).toBe(false);
  });

  it("omits the base URL and cookie domain without GATEWAY_URL", () => {
    vi.stubEnv("DEV", false);
    workerEnv.GATEWAY_URL = undefined as unknown as string;

    const options = createAuthOptions();
    expect(options).not.toHaveProperty("baseURL");
    expect(options.advanced).not.toHaveProperty("crossSubDomainCookies");
    expect(options.rateLimit).toEqual({ enabled: true });
  });

  it("registers tanstackStartCookies last", () => {
    expect(createAuthOptions().plugins.map((plugin) => plugin.id)).toEqual([
      "admin",
      "organization",
      "tanstack-start-cookies",
    ]);
  });
});
