import { describe, expect, it, vi } from "vitest";

// Only the server-function declarations are under test; stub what they import.
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("@/auth", () => ({ auth: {}, createAuth: vi.fn() }));
vi.mock("@/middleware/auth", () => ({
  authMiddleware: {},
  organizationMemberMiddleware: {},
  organizationAdminMiddleware: {},
  organizationOwnerMiddleware: {},
}));
vi.mock("@/middleware/publicError", () => ({ publicErrorMiddleware: {} }));
vi.mock("@/server/mcp-auth/config", () => ({ getMcpAuth: vi.fn() }));
vi.mock("@/server/mcp-auth/consent", () => ({
  buildConsentContext: vi.fn(),
}));
vi.mock("@/server/services/McpConnectionService", () => ({
  McpConnectionService: {},
}));
vi.mock("@/server/services/AdminService", () => ({ AdminService: {} }));
vi.mock("@/server/services/AppAccessService", () => ({
  AppAccessService: {},
}));
vi.mock("@/server/services/AppService", () => ({ AppService: {} }));
vi.mock("@/server/services/MembershipService", () => ({
  MembershipService: {},
}));
vi.mock("@/server/services/InvitationService", () => ({
  InvitationService: {},
}));
vi.mock("@/server/email/sendEmail", () => ({ isEmailConfigured: vi.fn() }));
vi.mock("@/server/services/OnboardingService", () => ({
  OnboardingService: {},
}));
vi.mock("@/server/services/OrganizationService", () => ({
  OrganizationService: {},
}));
vi.mock("@/server/services/UserPatService", () => ({ UserPatService: {} }));

/**
 * A GET server function runs on any GET that carries `?payload=`, including a
 * top-level navigation, and the CSRF middleware (src/start.ts) lets
 * same-origin navigations through. So a GET that changes state could be
 * triggered by any same-origin link or redirect (e.g. sign-in's return_to).
 * GET is reserved for these reads; everything else must be POST, which a
 * link or redirect can never send.
 */
const READS = [
  "getActiveOrganization",
  "getAppAccessState",
  "getApps",
  "getEmailStatus",
  "getMyApps",
  "getOnboardingStatus",
  "hasOwner",
  "listMembers",
  "listUserTokens",
];

const modules = import.meta.glob(["./*.ts", "!./*.test.ts"], {
  eager: true,
});

const serverFnMethods = Object.fromEntries(
  Object.values(modules).flatMap((exports) =>
    Object.entries(exports as Record<string, unknown>).flatMap(
      ([name, value]) => {
        const method = (value as { method?: unknown } | null)?.method;
        return typeof value === "function" && typeof method === "string"
          ? [[name, method]]
          : [];
      },
    ),
  ),
);

describe("gateway server function methods", () => {
  it("finds the server functions", () => {
    expect(Object.keys(serverFnMethods)).toEqual(
      expect.arrayContaining([
        "acceptInvitation",
        "deactivateUser",
        "deleteUser",
        "getConsentContext",
        "inviteMember",
        "listMyMcpConnections",
        "revokeMyMcpConnection",
        "updateMemberRole",
        ...READS,
      ]),
    );
  });

  it("declares GET only for reads and POST for everything else", () => {
    const gets = Object.entries(serverFnMethods)
      .filter(([, method]) => method === "GET")
      .map(([name]) => name)
      .sort();
    expect(gets).toEqual(READS);
  });
});
