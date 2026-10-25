/**
 * The sign-in provider tools on the gateway's own /mcp against a migrated
 * SQLite database: owners and admins (read-only connections too) list and
 * show every catalog provider with its state, the settings by name and
 * whether each is set, the redirect URL and the command; never a value. A
 * member sees neither tool; there is no tool that adds or removes a
 * provider; each call leaves one `mcp_tool_calls` row. Drives
 * serveGatewayMcp with resolved callers, as provider-tools.sqlite.test.ts
 * does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    APP_BASE_DOMAIN: "apps.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    DB: {},
  } as Record<string, unknown>,
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: hoisted.waitUntil,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => hoisted.testDb.current }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));

import { generateKeyPairSync } from "node:crypto";
import { SIGN_IN_PROVIDER_IDS } from "@every-app/sdk/internal";
import { SIGNIN_TOOLS, type McpPrincipal } from "@every-app/toolbus";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "@/server/repositories/McpToolCallRepository";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { clearCatalogSyncClaimsForTests } from "./catalog-sync";
import { serveGatewayMcp } from "./gateway-mcp";
import { resetToolBusForTests } from "./runtime";

const GATEWAY = "https://gateway.example.com";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};
const SIGNIN_NAMES = SIGNIN_TOOLS.map((tool) => `everyapp_${tool.name}`);

/** Setting values that must never come back from a tool. */
const GOOGLE_ID = "goog-client-1234.apps.googleusercontent.com";
const GOOGLE_SECRET = "GOCSPX-never-shown-7f3a9c";
const GITHUB_ID = "Iv1.github-id-never-shown";
const OIDC_SECRET = "oidc-secret-never-shown-55";
const SETTINGS: Record<string, string> = {
  // On.
  GOOGLE_SIGNIN_CLIENT_ID: GOOGLE_ID,
  GOOGLE_SIGNIN_CLIENT_SECRET: GOOGLE_SECRET,
  // Half set: needs setup.
  GITHUB_SIGNIN_CLIENT_ID: GITHUB_ID,
  // All there but the issuer is not https: needs setup, with the problem.
  OIDC_SIGNIN_ISSUER: "http://idp.example.com",
  OIDC_SIGNIN_CLIENT_ID: "oidc-client",
  OIDC_SIGNIN_CLIENT_SECRET: OIDC_SECRET,
  OIDC_SIGNIN_LABEL: "Okta",
};

let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;

function callerFor(
  userId: string,
  orgRole: string,
  principal: Partial<McpPrincipal> = {},
): McpCaller {
  return {
    kind: "caller",
    principal: {
      userId,
      email: `${orgRole}@example.com`,
      organizationId,
      organizationName: "acme",
      orgRole,
      credential: { kind: "pat", id: `pat_${orgRole}` },
      access: "write",
      ...principal,
    },
    apps: {},
  };
}
const owner = () => callerFor(ownerId, "owner");
const admin = (principal: Partial<McpPrincipal> = {}) =>
  callerFor(adminId, "admin", principal);
const member = () => callerFor(memberId, "member");

function mcp(
  method: string,
  params: Record<string, unknown>,
  as: McpCaller,
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return serveGatewayMcp(
    new Request(`${GATEWAY}/mcp`, {
      method: "POST",
      headers: {
        host: "gateway.example.com",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: MODERN_META },
      }),
    }),
    as,
  );
}

async function settle(): Promise<void> {
  await Promise.all(
    hoisted.waitUntil.mock.calls.map(([task]) => Promise.resolve(task)),
  );
}

async function signInToolNames(as: McpCaller): Promise<string[]> {
  const response = await mcp("tools/list", {}, as);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return body.result.tools
    .map((tool) => tool.name)
    .filter((name) => /signin|sign_in/.test(name));
}

type Answer =
  | { ok: true; data: Record<string, unknown>; text: string }
  | { ok: false; error: string }
  | { ok: false; unknown: true; message: string };

async function call(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<Answer> {
  const response = await mcp("tools/call", { name, arguments: args }, as);
  const body = (await response.json()) as {
    result?: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: { message: string };
  };
  await settle();
  if (body.error)
    return { ok: false, unknown: true, message: body.error.message };
  const result = body.result!;
  const text = result.content[0]?.text ?? "";
  if (result.isError) return { ok: false, error: text };
  return { ok: true, data: result.structuredContent ?? {}, text };
}

type Listed = {
  id: string;
  label: string;
  status: string;
  missing: string[];
  set: string[];
  settings: { name: string; set: boolean; required: boolean }[];
  callbackUrl: string;
  command: string;
  setup: string;
  problem?: string;
};

function expectNoValue(text: string) {
  for (const value of Object.values(SETTINGS).filter(
    // The OIDC label is the button's text, public on the sign-in page once
    // the provider is on; here it is off, so not even that is shown.
    (value) => value.length > 6,
  )) {
    expect(text, value).not.toContain(value);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(SETTINGS)) delete hoisted.env[name];
  hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "self_hosted";
});

beforeEach(async () => {
  db = await createTestDb();
  hoisted.testDb.current = db;
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  hoisted.env["JWT_PRIVATE_KEY"] = pair.privateKey;
  Object.assign(hoisted.env, SETTINGS);
  organizationId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId,
    role: "owner",
    email: "owner@example.com",
  });
  adminId = await seedMember(db, {
    organizationId,
    role: "admin",
    email: "admin@example.com",
  });
  memberId = await seedMember(db, {
    organizationId,
    role: "member",
    email: "member@example.com",
  });
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the sign-in provider tools on /mcp", () => {
  it("lists both to an owner, an admin and a read-only admin, in both deployment modes, and neither to a member, who gets Unknown tool", async () => {
    expect(await signInToolNames(owner())).toEqual(SIGNIN_NAMES);
    expect(await signInToolNames(admin())).toEqual(SIGNIN_NAMES);
    expect(await signInToolNames(admin({ access: "read" }))).toEqual(
      SIGNIN_NAMES,
    );
    expect(await signInToolNames(member())).toEqual([]);
    for (const name of SIGNIN_NAMES) {
      expect(
        await call(
          name,
          name.endsWith("show") ? { id: "google" } : {},
          member(),
        ),
      ).toEqual({ ok: false, unknown: true, message: `Unknown tool: ${name}` });
    }
    hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "hosted";
    resetToolBusForTests();
    expect(await signInToolNames(owner())).toEqual(SIGNIN_NAMES);
  });

  it("lists every catalog provider with its state, the settings by name and whether each is set, the redirect URL and the command; never a value", async () => {
    const answer = await call("everyapp_signin_list", {}, admin());
    if (!answer.ok) throw new Error(JSON.stringify(answer));
    expectNoValue(answer.text);
    const providers = answer.data["providers"] as Listed[];
    expect(providers.map((provider) => provider.id)).toEqual([
      ...SIGN_IN_PROVIDER_IDS,
    ]);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    expect(byId.get("google")).toMatchObject({
      label: "Google",
      status: "on",
      missing: [],
      set: ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"],
      callbackUrl: "https://gateway.example.com/api/auth/callback/google",
      command: "pnpm everyapp signin add google",
      setup: "setup/signin-google.md",
    });
    expect(byId.get("google")!.problem).toBeUndefined();
    expect(byId.get("github")).toMatchObject({
      status: "incomplete",
      missing: ["GITHUB_SIGNIN_CLIENT_SECRET"],
      set: ["GITHUB_SIGNIN_CLIENT_ID"],
      problem: expect.stringContaining("GITHUB_SIGNIN_CLIENT_SECRET"),
    });
    expect(
      byId
        .get("github")!
        .settings.map((setting) => [
          setting.name,
          setting.set,
          setting.required,
        ]),
    ).toEqual([
      ["GITHUB_SIGNIN_CLIENT_ID", true, true],
      ["GITHUB_SIGNIN_CLIENT_SECRET", false, true],
    ]);
    // Every setting there, the issuer malformed: off, and says why. The
    // label it would show is the catalog's, not the setting's.
    expect(byId.get("oidc")).toMatchObject({
      label: "SSO",
      status: "incomplete",
      missing: [],
      problem: expect.stringContaining("OIDC_SIGNIN_ISSUER must be an https"),
    });
    expect(byId.get("apple")).toMatchObject({
      status: "off",
      missing: ["APPLE_SIGNIN_CLIENT_ID", "APPLE_SIGNIN_CLIENT_SECRET"],
      set: [],
    });
    expect(answer.data).toMatchObject({
      password: { on: true, offPending: false },
      access: { on: false, label: null },
      operator: "self_hosted",
      next: expect.stringContaining("pnpm everyapp signin add <id>"),
    });
  });

  it("shows one provider for a read-only admin, refuses an id the catalog doesn't have, and leaves one audit row per call", async () => {
    const shown = await call(
      "everyapp_signin_show",
      { id: "github" },
      admin({ access: "read" }),
    );
    if (!shown.ok) throw new Error(JSON.stringify(shown));
    expectNoValue(shown.text);
    expect(shown.data["provider"]).toMatchObject({
      id: "github",
      status: "incomplete",
      console: "https://github.com/settings/developers",
      appNoun: "OAuth App",
      scopes: ["read:user", "user:email"],
      callbackUrl: "https://gateway.example.com/api/auth/callback/github",
    });
    expect(shown.data["next"]).toEqual(
      expect.stringContaining("signin add <id>"),
    );
    const on = await call("everyapp_signin_show", { id: "google" }, owner());
    if (!on.ok) throw new Error(JSON.stringify(on));
    expect(on.data["next"]).toBeUndefined();

    // Outside the schema's enum: refused before the handler.
    const unknown = await call("everyapp_signin_show", { id: "okta" }, owner());
    expect(unknown.ok).toBe(false);

    const page = await McpToolCallRepository.listForOrganization({
      organizationId,
      limit: TOOL_CALL_PAGE_MAX,
    });
    const rows = page.calls.filter((row) =>
      row.tool.name.startsWith("everyapp_signin_"),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.app.slug === "everyapp")).toBe(true);
    expect(rows.at(-1)).toMatchObject({
      tool: { name: "everyapp_signin_show" },
      user: { id: adminId },
      decision: "allowed",
      outcome: "ok",
    });
  });

  it("says when EMAIL_PASSWORD_SIGN_IN=false waits for an owner to connect a provider", async () => {
    hoisted.env["EMAIL_PASSWORD_SIGN_IN"] = "false";
    try {
      const listing = await call("everyapp_signin_list", {}, owner());
      if (!listing.ok) throw new Error(JSON.stringify(listing));
      // Google is on but no owner has connected it: passwords stay on.
      expect(listing.data["password"]).toEqual({
        on: true,
        offPending: true,
      });
    } finally {
      delete hoisted.env["EMAIL_PASSWORD_SIGN_IN"];
    }
  });
});
