import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerEnv = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "test-secret",
  DB: {},
  GATEWAY_URL: "https://gateway.example.com",
  APP_BASE_DOMAIN: undefined as string | undefined,
  EMAIL: undefined as { send: (message: unknown) => unknown } | undefined,
  EMAIL_FROM: undefined as string | undefined,
}));

const captured = vi.hoisted(() => ({
  authOptions: undefined as unknown,
}));

// What accessConfigFromEnv returns: Access sign-in off unless a test sets it.
const accessSettings = vi.hoisted(() => ({
  current: {
    oidc: null as { label: string } | null,
    outerRing: null as object | null,
    autoJoinDomains: [] as string[],
    passwordSignIn: true,
    problems: [] as string[],
  },
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

vi.mock("better-auth", () => ({
  betterAuth: (options: unknown) => {
    captured.authOptions = options;
    return { options };
  },
}));

vi.mock("better-auth/api", () => ({
  APIError: class APIError extends Error {
    constructor(status: string, body?: { message?: string }) {
      super(body?.message ?? status);
    }
  },
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

vi.mock("@/db", () => ({ db: {}, schema: {} }));

vi.mock("./cloudflare-access", () => ({
  ACCESS_PROVIDER_ID: "cloudflare-access",
  accessConfigFromEnv: () => accessSettings.current,
  isAccessSignInConfigured: (config: { oidc: unknown; outerRing: unknown }) =>
    Boolean(config.oidc || config.outerRing),
  // The real one also keeps passwords on until an owner has linked Access
  // (see the SQLite tests).
  isPasswordSignInOn: async (config: { passwordSignIn: boolean }) =>
    config.passwordSignIn,
  cloudflareAccess: (options: unknown) => ({
    id: "cloudflare-access",
    options,
  }),
}));

vi.mock("@/db/schema", () => ({}));

vi.mock("@/server/invitation-token", () => ({
  findPendingInvitationByToken: vi.fn(),
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

import { findPendingInvitationByToken } from "@/server/invitation-token";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { createAuth } from "./config";

type AuthOptions = {
  emailAndPassword: {
    sendResetPassword: (input: {
      user: { email: string };
      url: string;
      token: string;
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
        url: "https://gateway.example.com/api/auth/reset-password/test",
        token: "test",
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

  it("emails a reset link with the token in the query string, not the path", async () => {
    const send = vi.fn(async () => ({ messageId: "m-1" }));
    workerEnv.EMAIL = { send };
    workerEnv.EMAIL_FROM = "Every App <noreply@example.com>";
    try {
      createAuth();
      await (
        captured.authOptions as AuthOptions
      ).emailAndPassword.sendResetPassword({
        user: { email: "user@example.net" },
        url: "https://gateway.example.com/api/auth/reset-password/tok_1?callbackURL=x",
        token: "tok_1",
      });

      const [message] = send.mock.calls[0] as unknown as [{ text: string }];
      expect(message.text).toContain(
        "https://gateway.example.com/reset-password?token=tok_1",
      );
      expect(message.text).not.toContain("/api/auth/reset-password/");
    } finally {
      workerEnv.EMAIL = undefined;
      workerEnv.EMAIL_FROM = undefined;
    }
  });

  describe("reset link destination", () => {
    async function resetLinkFor(callbackURL: string): Promise<string> {
      const send = vi.fn(async (_message: unknown) => ({
        messageId: "m-1",
      }));
      workerEnv.EMAIL = { send };
      workerEnv.EMAIL_FROM = "Every App <noreply@example.com>";
      try {
        createAuth();
        await (
          captured.authOptions as AuthOptions
        ).emailAndPassword.sendResetPassword({
          user: { email: "user@example.net" },
          // What Better Auth builds from the requested redirectTo.
          url: `https://gateway.example.com/api/auth/reset-password/tok_1?callbackURL=${encodeURIComponent(callbackURL)}`,
          token: "tok_1",
        });
        const { text } = send.mock.calls[0]![0] as { text: string };
        return text.slice(text.indexOf("https://"));
      } finally {
        workerEnv.EMAIL = undefined;
        workerEnv.EMAIL_FROM = undefined;
      }
    }

    it("keeps the redirect and return_to forgot-password asked for", async () => {
      const link = new URL(
        await resetLinkFor(
          "https://gateway.example.com/reset-password?redirect=%2Fadmin%2Fusers&return_to=https%3A%2F%2Ftodo.gateway.example.com%2Flists",
        ),
      );

      expect(`${link.origin}${link.pathname}`).toBe(
        "https://gateway.example.com/reset-password",
      );
      expect(Object.fromEntries(link.searchParams)).toEqual({
        redirect: "/admin/users",
        return_to: "https://todo.gateway.example.com/lists",
        token: "tok_1",
      });
    });

    it("falls back to the plain reset page for any other destination", async () => {
      for (const callbackURL of [
        "https://evil.example.net/reset-password?redirect=%2F",
        "https://todo.gateway.example.com/reset-password",
        "https://gateway.example.com/sign-in?redirect=%2F",
        "everyapp://reset-password",
        "",
      ]) {
        expect(await resetLinkFor(callbackURL)).toBe(
          "https://gateway.example.com/reset-password?token=tok_1",
        );
      }
    });
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

  it("scopes the session cookie to APP_BASE_DOMAIN, the apps' parent, never the zone above it", () => {
    vi.stubEnv("DEV", false);
    workerEnv.GATEWAY_URL = "https://apps.example.com";
    workerEnv.APP_BASE_DOMAIN = "apps.example.com";
    try {
      expect(createAuthOptions().advanced?.crossSubDomainCookies).toEqual({
        enabled: true,
        domain: "apps.example.com",
      });
    } finally {
      workerEnv.APP_BASE_DOMAIN = undefined;
    }
  });

  it("omits the base URL and cookie domain without GATEWAY_URL", () => {
    vi.stubEnv("DEV", false);
    workerEnv.GATEWAY_URL = undefined as unknown as string;

    const options = createAuthOptions();
    expect(options).not.toHaveProperty("baseURL");
    expect(options.advanced).not.toHaveProperty("crossSubDomainCookies");
    expect(options.rateLimit).toEqual({ enabled: true });
  });

  it("only lets the setup claim create organizations and closes unused org endpoints", () => {
    const options = createAuthOptions() as CapturedOptions & {
      disabledPaths?: string[];
    };
    const organization = (
      options.plugins as { id: string; options?: Record<string, unknown> }[]
    ).find((plugin) => plugin.id === "organization");
    expect(organization?.options?.allowUserToCreateOrganization).toBe(false);
    expect(organization?.options?.invitationExpiresIn).toBe(72 * 60 * 60);
    expect(organization?.options).not.toHaveProperty("sendInvitationEmail");
    expect(options.disabledPaths).toEqual(
      expect.arrayContaining([
        "/organization/create",
        "/organization/delete",
        "/organization/update-member-role",
        "/organization/add-member",
        "/organization/leave",
        // Accepting by invitation id, and the endpoints that list every
        // pending invitation id to any member.
        "/organization/accept-invitation",
        "/organization/list-invitations",
        "/organization/get-full-organization",
      ]),
    );
  });

  it("registers tanstackStartCookies last", () => {
    expect(createAuthOptions().plugins.map((plugin) => plugin.id)).toEqual([
      "admin",
      "organization",
      "cloudflare-access",
      "tanstack-start-cookies",
    ]);
  });

  describe("with Cloudflare Access sign-in", () => {
    const off = accessSettings.current;
    afterEach(() => {
      accessSettings.current = off;
    });

    it("trusts the Access provider for linking only when Access sign-in is configured", () => {
      expect(createAuthOptions()).not.toHaveProperty("account");

      accessSettings.current = { ...off, oidc: { label: "Company SSO" } };
      expect(createAuthOptions()).toMatchObject({
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: ["cloudflare-access"],
          },
        },
      });
      // Better Auth's default (require the existing account's email to be
      // verified before linking) is left alone.
      expect(
        (
          createAuthOptions() as unknown as {
            account: { accountLinking: Record<string, unknown> };
          }
        ).account.accountLinking,
      ).not.toHaveProperty("requireLocalEmailVerified");
    });

    it("hands the plugin its settings and the gateway URL", () => {
      accessSettings.current = { ...off, outerRing: {} };
      const plugin = createAuthOptions().plugins.find(
        (entry) => entry.id === "cloudflare-access",
      ) as unknown as { options: unknown };
      expect(plugin.options).toEqual({
        config: accessSettings.current,
        gatewayUrl: "https://gateway.example.com",
      });
    });
  });
});

type BeforeHook = (ctx: {
  path: string;
  request?: Request;
  body?: { email?: string };
}) => Promise<void>;

describe("createAuth sign-up and organization hooks", () => {
  const before = () =>
    (createAuth() as unknown as { options: { hooks: { before: BeforeHook } } })
      .options.hooks.before;
  const mockHasOwner = vi.mocked(hasAnyOwnerMembership);
  const mockFindInvitation = vi.mocked(findPendingInvitationByToken);

  function httpRequest(path: string): Request {
    return new Request(`https://gateway.example.com/api/auth${path}`, {
      method: "POST",
    });
  }

  beforeEach(() => {
    mockHasOwner.mockReset();
    mockFindInvitation.mockReset();
  });

  it("rejects HTTP sign-up without an invitation, before and after an owner exists", async () => {
    for (const hasOwner of [false, true]) {
      mockHasOwner.mockResolvedValue(hasOwner);
      await expect(
        before()({
          path: "/sign-up/email",
          request: httpRequest("/sign-up/email"),
          body: { email: "squatter@example.com" },
        }),
      ).rejects.toThrow();
    }
  });

  it("accepts HTTP sign-up with a live invite link for the same email", async () => {
    mockFindInvitation.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-1",
      email: "invitee@example.com",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      before()({
        path: "/sign-up/email",
        request: httpRequest("/sign-up/email?invitationToken=einv_secret"),
        body: { email: "Invitee@Example.com" },
      }),
    ).resolves.toBeUndefined();
    expect(mockFindInvitation).toHaveBeenCalledWith("einv_secret");
  });

  it("never looks an invitation up by its id", async () => {
    await expect(
      before()({
        path: "/sign-up/email",
        request: httpRequest("/sign-up/email?invitationId=inv-1"),
        body: { email: "invitee@example.com" },
      }),
    ).rejects.toThrow();
    expect(mockFindInvitation).not.toHaveBeenCalled();
  });

  it("lets server-side calls through (the setup claim signs up the owner)", async () => {
    await expect(
      before()({
        path: "/sign-up/email",
        body: { email: "owner@example.com" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      before()({ path: "/organization/create" }),
    ).resolves.toBeUndefined();
  });

  describe("with password sign-in off", () => {
    const off = accessSettings.current;
    afterEach(() => {
      accessSettings.current = off;
    });

    const passwordPaths = [
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/tok_1",
    ];

    it("refuses password sign-in, sign-up and resets over HTTP", async () => {
      accessSettings.current = {
        ...off,
        oidc: { label: "Company SSO" },
        passwordSignIn: false,
      };
      mockFindInvitation.mockResolvedValue({
        id: "inv-1",
        organizationId: "org-1",
        email: "invitee@example.com",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      });
      for (const path of passwordPaths) {
        await expect(
          before()({
            path,
            request: httpRequest(`${path}?invitationToken=einv_secret`),
            body: { email: "invitee@example.com" },
          }),
        ).rejects.toThrow(
          "Password sign-in is turned off on this gateway. Sign in with Company SSO.",
        );
      }
    });

    it("still lets the setup claim create the owner server-side", async () => {
      accessSettings.current = {
        ...off,
        outerRing: {},
        passwordSignIn: false,
      };
      await expect(
        before()({
          path: "/sign-up/email",
          body: { email: "owner@example.com" },
        }),
      ).resolves.toBeUndefined();
    });

    it("leaves other endpoints alone", async () => {
      accessSettings.current = {
        ...off,
        oidc: { label: "Company SSO" },
        passwordSignIn: false,
      };
      for (const path of ["/sign-in/social", "/get-session", "/sign-out"]) {
        await expect(
          before()({ path, request: httpRequest(path) }),
        ).resolves.toBeUndefined();
      }
    });
  });

  it("rejects HTTP organization creation until the gateway is claimed", async () => {
    mockHasOwner.mockResolvedValue(false);
    await expect(
      before()({
        path: "/organization/create",
        request: httpRequest("/organization/create"),
      }),
    ).rejects.toThrow();
  });
});
