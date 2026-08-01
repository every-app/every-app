import { beforeEach, describe, expect, it, vi } from "vitest";

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
  admin: () => ({ plugin: "admin" }),
  organization: (options: unknown) => ({ plugin: "organization", options }),
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
