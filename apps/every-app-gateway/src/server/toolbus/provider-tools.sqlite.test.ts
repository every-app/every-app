/**
 * The provider tools on the gateway's own /mcp against a migrated SQLite
 * database: every member lists the catalog and the rows (set-ness and
 * binding for owners and admins alone, never a value); an admin with a
 * read & write connection adds a row from the spec alone and removes an
 * unbound, unlisted one; a row that is there is never replaced, a bound
 * row and a listed row are never removed; a hosted gateway hides the two
 * writers; and each call leaves one `mcp_tool_calls` row. Drives
 * serveGatewayMcp with resolved callers, as workspace-tools.sqlite.test.ts
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
import { providerBindingKey, providerRegistry } from "@every-app/sdk/internal";
import { PROVIDER_TOOLS, type McpPrincipal } from "@every-app/toolbus";
import { eq } from "drizzle-orm";
import { providers } from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import {
  gatewayProviders,
  resetGatewayProvidersForTests,
} from "@/server/providers";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "@/server/repositories/McpToolCallRepository";
import { deployLiveApp } from "@/test/registry";
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
const PROVIDER_NAMES = PROVIDER_TOOLS.map((tool) => `everyapp_${tool.name}`);

/** Specs with ids no catalog is likely to take. */
const northwind = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
  hint: "A read-only key is enough.",
  secrets: [{ name: "NORTHWIND_API_KEY", hint: "From Settings → API keys." }],
};
const contoso = {
  id: "contoso",
  name: "Contoso",
  docs: "https://contoso.dev/docs/auth",
  hosts: ["api.contoso.dev"],
  auth: { kind: "header", secret: "CONTOSO_API_KEY", header: "x-api-key" },
};
const fabrikam = {
  id: "fabrikam",
  name: "Fabrikam",
  docs: "https://fabrikam.net/api",
  hosts: ["api.fabrikam.net"],
  auth: { kind: "query", secret: "FABRIKAM_API_KEY", param: "key" },
};
const CONTOSO_VALUE = "contoso-secret-value-9f8e7d";

let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;

/** A resolved caller: a member of Acme, by role, through a personal token unless told otherwise. */
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

/** A 2026-07-28 request to the gateway's /mcp. */
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

/** The audit rows are written after the response; wait for them. */
async function settle(): Promise<void> {
  await Promise.all(
    hoisted.waitUntil.mock.calls.map(([task]) => Promise.resolve(task)),
  );
}

async function providerToolNames(as: McpCaller): Promise<string[]> {
  const response = await mcp("tools/list", {}, as);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return body.result.tools
    .map((tool) => tool.name)
    .filter((name) => PROVIDER_NAMES.includes(name));
}

type Answer =
  | { ok: true; data: Record<string, unknown>; text: string }
  | { ok: false; error: string }
  | { ok: false; unknown: true; message: string };

/** Call a tool and read its answer: data, a tool error, or Unknown tool. */
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

/** The answer's data, failing the test on a refusal. */
async function data(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<Record<string, unknown>> {
  const answer = await call(name, args, as);
  if (!answer.ok) {
    throw new Error(
      `${name} refused: ${"error" in answer ? answer.error : answer.message}`,
    );
  }
  return answer.data;
}

async function refusal(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<string> {
  const answer = await call(name, args, as);
  if (answer.ok) throw new Error(`${name} answered ${answer.text}`);
  return "error" in answer ? answer.error : answer.message;
}

type ListedProvider = {
  id: string;
  source: string;
  apps: string[];
  settings: { name: string; hint?: string; set?: boolean }[];
  bound?: boolean;
  addedBy?: string | null;
};

async function listed(as: McpCaller): Promise<ListedProvider[]> {
  return (await data("everyapp_provider_list", {}, as))[
    "providers"
  ] as ListedProvider[];
}

/** A row as the CLI writes it, bound when told. */
async function insertRow(
  spec: { id: string; [key: string]: unknown },
  options: { bound?: boolean; addedBy?: string } = {},
): Promise<void> {
  const [row] = providerRegistry([{ id: spec.id, spec }]).rows();
  if (!row) throw new Error(`${spec.id} doesn't resolve`);
  await db.insert(providers).values({
    id: spec.id,
    spec: JSON.stringify(spec),
    addedBy: options.addedBy ?? "operator@example.com",
    addedAt: new Date(1000),
    updatedAt: new Date(1000),
    ...(options.bound
      ? { boundTo: providerBindingKey(row.capability), boundAt: new Date(2000) }
      : {}),
  });
  resetGatewayProvidersForTests();
}

/** Deploy an app live with the manifest given, in Acme unless told otherwise. */
async function deploy(
  appSlug: string,
  manifest: Record<string, unknown>,
  org: { organizationId: string; userId: string } = {
    organizationId,
    userId: ownerId,
  },
): Promise<void> {
  await deployLiveApp(db, {
    organizationId: org.organizationId,
    appSlug,
    name: appSlug,
    description: `The ${appSlug} app`,
    manifest: { id: appSlug, name: appSlug, ...manifest },
    deployerUserId: org.userId,
    appBaseDomain: "apps.example.com",
  });
}

async function activityRows() {
  const page = await McpToolCallRepository.listForOrganization({
    organizationId,
    limit: TOOL_CALL_PAGE_MAX,
  });
  return page.calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "self_hosted";
  delete hoisted.env["CONTOSO_API_KEY"];
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
  resetGatewayProvidersForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the provider tools on /mcp", () => {
  it("lists all three to an owner and an admin, the list alone to a read-only admin and to a member, and hides the writers on a hosted gateway", async () => {
    expect(await providerToolNames(owner())).toEqual(PROVIDER_NAMES);
    expect(await providerToolNames(admin())).toEqual(PROVIDER_NAMES);
    expect(await providerToolNames(admin({ access: "read" }))).toEqual([
      "everyapp_provider_list",
    ]);
    expect(await providerToolNames(member())).toEqual([
      "everyapp_provider_list",
    ]);
    // A member calling a writer: Unknown tool, as for any hidden tool.
    expect(
      await call("everyapp_provider_add", { spec: northwind }, member()),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_provider_add",
    });
    // A hosted gateway: the list stays, the writers are gone for the owner too.
    hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "hosted";
    resetToolBusForTests();
    expect(await providerToolNames(owner())).toEqual([
      "everyapp_provider_list",
    ]);
    expect(
      await call("everyapp_provider_add", { spec: northwind }, owner()),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_provider_add",
    });
    expect(
      await call("everyapp_provider_remove", { id: "northwind" }, owner()),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_provider_remove",
    });
    expect((await gatewayProviders()).rows()).toEqual([]);
    const rows = await activityRows();
    expect(
      rows
        .filter((row) => row.tool.name !== "everyapp_provider_list")
        .map((row) => [row.tool.name, row.decision, row.reason]),
    ).toEqual([
      ["everyapp_provider_remove", "blocked", "unknown_tool"],
      ["everyapp_provider_add", "blocked", "unknown_tool"],
      ["everyapp_provider_add", "blocked", "role_required"],
    ]);
  });

  it("lists the catalog and the rows for any member, with the caller's own organization's apps, and set-ness and binding for owners and admins alone, never a value", async () => {
    await insertRow(contoso, { bound: true, addedBy: "ben@example.com" });
    await insertRow(northwind);
    hoisted.env["CONTOSO_API_KEY"] = CONTOSO_VALUE;
    await deploy("crm", {
      capabilities: { dataforseo: { access: "read", why: "Keyword data." } },
    });
    await deploy("billing", {
      capabilities: { contoso: { access: "read", why: "Invoices." } },
    });
    // Another organization's app lists contoso too: never named to Acme.
    const otherOrg = await seedOrganization(db, "globex");
    const otherOwner = await seedMember(db, {
      organizationId: otherOrg,
      role: "owner",
      email: "globex@example.com",
    });
    await deploy(
      "ledger",
      { capabilities: { contoso: { access: "read", why: "Ledgers." } } },
      { organizationId: otherOrg, userId: otherOwner },
    );

    const answer = await call("everyapp_provider_list", {}, member());
    if (!answer.ok) throw new Error("the member was refused");
    expect(answer.text).not.toContain(CONTOSO_VALUE);
    const mine = answer.data["providers"] as ListedProvider[];
    expect(answer.data["registered"]).toBe(2);
    expect(mine.map((provider) => provider.id)).toContain("dataforseo");
    expect(mine.map((provider) => provider.id)).toContain("openai");
    expect(mine.map((provider) => provider.id)).toContain("google-workspace");
    expect(mine.map((provider) => provider.id)).not.toContain("email");
    expect(mine.slice(-2).map((provider) => provider.id)).toEqual([
      "contoso",
      "northwind",
    ]);
    const forseo = mine.find((provider) => provider.id === "dataforseo")!;
    expect(forseo).toMatchObject({
      source: "catalog",
      kind: "api_key",
      auth: { kind: "basic", as: "pair" },
      hosts: ["api.dataforseo.com", "sandbox.dataforseo.com"],
      apps: ["crm"],
    });
    expect(forseo.settings.map((setting) => setting.name)).toEqual([
      "DATAFORSEO_API_KEY",
    ]);
    const contosoListed = mine.find((provider) => provider.id === "contoso")!;
    expect(contosoListed).toMatchObject({
      source: "row",
      auth: { kind: "header", header: "x-api-key" },
      hosts: ["api.contoso.dev"],
      docs: "https://contoso.dev/docs/auth",
      addedBy: "ben@example.com",
      addedAt: new Date(1000).toISOString(),
      apps: ["billing"],
      settings: [{ name: "CONTOSO_API_KEY" }],
    });
    // The member sees neither set-ness nor the binding.
    for (const provider of mine) {
      expect(provider, provider.id).not.toHaveProperty("bound");
      for (const setting of provider.settings) {
        expect(setting, `${provider.id} ${setting.name}`).not.toHaveProperty(
          "set",
        );
      }
    }
    const northwindListed = mine.find(
      (provider) => provider.id === "northwind",
    )!;
    expect(northwindListed).toMatchObject({
      hint: "A read-only key is enough.",
      settings: [
        { name: "NORTHWIND_API_KEY", hint: "From Settings → API keys." },
      ],
      apps: [],
    });

    // An admin: set as the proxies read it (a bound row's key counts, an
    // unbound row's never), and the binding; still never the value.
    const adminAnswer = await call("everyapp_provider_list", {}, admin());
    if (!adminAnswer.ok) throw new Error("the admin was refused");
    expect(adminAnswer.text).not.toContain(CONTOSO_VALUE);
    const theirs = adminAnswer.data["providers"] as ListedProvider[];
    expect(theirs.find((provider) => provider.id === "contoso")).toMatchObject({
      bound: true,
      settings: [{ name: "CONTOSO_API_KEY", set: true }],
    });
    expect(
      theirs.find((provider) => provider.id === "northwind"),
    ).toMatchObject({
      bound: false,
      settings: [{ name: "NORTHWIND_API_KEY", set: false }],
    });
    expect(
      theirs.find((provider) => provider.id === "dataforseo")!.settings,
    ).toEqual([
      { name: "DATAFORSEO_API_KEY", hint: expect.any(String), set: false },
    ]);
    // Unbound: the key counts as unset even when the Worker holds one.
    hoisted.env["NORTHWIND_API_KEY"] = "nw-value";
    try {
      expect(
        (await listed(owner())).find((provider) => provider.id === "northwind")!
          .settings,
      ).toEqual([
        {
          name: "NORTHWIND_API_KEY",
          hint: "From Settings → API keys.",
          set: false,
        },
      ]);
    } finally {
      delete hoisted.env["NORTHWIND_API_KEY"];
    }
  });

  it("adds a row from the spec alone for an admin: unbound, by the caller's email, served at once; never replaces; refuses a built-in id, a bad spec, a Gateway host, another row's setting and an app's own secret", async () => {
    await deploy("billing", { secrets: ["FABRIKAM_API_KEY"] });
    const added = await data(
      "everyapp_provider_add",
      { spec: northwind },
      admin(),
    );
    expect(added).toEqual({
      provider: {
        id: "northwind",
        name: "Northwind",
        hosts: ["api.northwind.io"],
        auth: { kind: "bearer" },
      },
      settings: ["NORTHWIND_API_KEY"],
      bound: false,
      next: "Set its key from the terminal: everyapp secret set NORTHWIND_API_KEY. The Gateway sends nothing to Northwind until then.",
    });
    const [row] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, "northwind"));
    expect(row).toMatchObject({
      id: "northwind",
      spec: JSON.stringify(northwind),
      addedBy: "admin@example.com",
      boundTo: null,
      boundAt: null,
    });
    // Served by this isolate at once (the cache is dropped), unbound.
    const registry = await gatewayProviders();
    expect(registry.sourceOf("northwind")).toBe("row");
    expect(registry.bound("northwind")).toBe(false);
    expect(
      (await listed(member())).find((provider) => provider.id === "northwind"),
    ).toMatchObject({ source: "row", addedBy: "admin@example.com" });

    // The same id again, with another host: never replaced, the row as it was.
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { ...northwind, hosts: ["evil.example.net"] } },
        owner(),
      ),
    ).toMatch(
      /^PROVIDER_EXISTS: northwind is registered on this Gateway already; this tool never replaces a row/,
    );
    const [same] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, "northwind"));
    expect(same?.spec).toBe(JSON.stringify(northwind));

    // A catalog id, a bad spec, this gateway's own host and its app domain,
    // another row's setting, and a deployed app's own secret.
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { ...northwind, id: "dataforseo" } },
        admin(),
      ),
    ).toMatch(/^PROVIDER_BUILTIN: dataforseo is a built-in provider/);
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { id: "contoso", name: "Contoso" } },
        admin(),
      ),
    ).toMatch(/^PROVIDER_SPEC_INVALID: /);
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { ...contoso, hosts: ["gateway.example.com"] } },
        admin(),
      ),
    ).toMatch(
      /^PROVIDER_HOST_REFUSED: gateway.example.com is this gateway's own host/,
    );
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { ...contoso, hosts: ["crm.apps.example.com"] } },
        admin(),
      ),
    ).toMatch(
      /^PROVIDER_HOST_REFUSED: crm.apps.example.com is under this gateway's app domain apps.example.com/,
    );
    expect(
      await refusal(
        "everyapp_provider_add",
        {
          spec: {
            ...contoso,
            auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
          },
        },
        admin(),
      ),
    ).toMatch(/^PROVIDER_SECRET_TAKEN: /);
    expect(
      await refusal("everyapp_provider_add", { spec: fabrikam }, admin()),
    ).toBe(
      "PROVIDER_SECRET_TAKEN: FABRIKAM_API_KEY is billing's own secret (its deployed manifest lists it under secrets), so a provider can't read it from the Gateway",
    );
    // A URL in place of the spec, and a replace flag, fail the schema.
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: "https://example.com/northwind.json" },
        admin(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_provider_add: /);
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: contoso, replace: true },
        admin(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_provider_add: /);
    expect(
      await refusal(
        "everyapp_provider_add",
        { spec: { ...contoso, example: "x".repeat(70 * 1024) } },
        admin(),
      ),
    ).toBe("INVALID_INPUT: spec is over 64 KiB");
    // Only northwind was written.
    expect((await gatewayProviders()).rows().map((row) => row.id)).toEqual([
      "northwind",
    ]);
    // One audit row per call, under everyapp, the refusals as tool errors.
    const rows = await activityRows();
    expect(rows.every((row) => row.app.slug === "everyapp")).toBe(true);
    expect(
      rows.filter((row) => row.tool.name === "everyapp_provider_add").length,
    ).toBe(11);
    expect(rows.at(-1)).toMatchObject({
      tool: { name: "everyapp_provider_add" },
      user: { id: adminId, email: "admin@example.com" },
      decision: "allowed",
      outcome: "ok",
    });
    expect(
      rows.filter((row) => row.outcome === "tool_error").length,
    ).toBeGreaterThanOrEqual(7);
  });

  it("removes an unbound row nobody lists; refuses a bound row, a listed row, a built-in and an unknown id", async () => {
    await insertRow(contoso, { bound: true });
    await insertRow(northwind);
    await insertRow(fabrikam);
    await deploy("billing", {
      capabilities: { fabrikam: { access: "read", why: "Rates." } },
    });
    expect(
      await refusal("everyapp_provider_remove", { id: "contoso" }, owner()),
    ).toBe(
      "PROVIDER_BOUND: contoso's key is set on this Gateway; its operator removes it from the terminal: everyapp provider remove contoso, then everyapp secret unset CONTOSO_API_KEY",
    );
    expect(
      await refusal("everyapp_provider_remove", { id: "fabrikam" }, admin()),
    ).toBe(
      "PROVIDER_IN_USE: billing lists fabrikam under capabilities; removing it would stop its calls at once (from the terminal: everyapp provider remove fabrikam --force)",
    );
    expect(
      await refusal("everyapp_provider_remove", { id: "dataforseo" }, admin()),
    ).toMatch(/^PROVIDER_BUILTIN: dataforseo is built in/);
    expect(
      await refusal("everyapp_provider_remove", { id: "everyapp" }, admin()),
    ).toMatch(/^PROVIDER_BUILTIN: /);
    expect(
      await refusal("everyapp_provider_remove", { id: "nope" }, admin()),
    ).toBe(
      "PROVIDER_NOT_FOUND: no provider nope is registered on this Gateway",
    );
    // A force flag fails the schema.
    expect(
      await refusal(
        "everyapp_provider_remove",
        { id: "fabrikam", force: true },
        admin(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_provider_remove: /);
    // Every row is still there (added at once, so in id order).
    expect((await gatewayProviders()).rows().map((row) => row.id)).toEqual([
      "contoso",
      "fabrikam",
      "northwind",
    ]);
    // The unbound, unlisted one goes, and the registry serves without it at once.
    expect(
      await data("everyapp_provider_remove", { id: "northwind" }, admin()),
    ).toEqual({
      provider: { id: "northwind", name: "Northwind" },
      removed: true,
      settings: ["NORTHWIND_API_KEY"],
      next: "The Gateway settings it named stay until its operator runs: everyapp secret unset NORTHWIND_API_KEY. No provider reads them again without a new everyapp secret set.",
    });
    expect((await gatewayProviders()).rows().map((row) => row.id)).toEqual([
      "contoso",
      "fabrikam",
    ]);
    expect(
      await db.select().from(providers).where(eq(providers.id, "northwind")),
    ).toEqual([]);
    expect(
      await refusal("everyapp_provider_remove", { id: "northwind" }, admin()),
    ).toMatch(/^PROVIDER_NOT_FOUND: /);
    // Through the write wrapper too, audited once naming the tool with via.
    await insertRow(northwind);
    await data(
      "everyapp_call_write",
      {
        name: "everyapp_provider_remove",
        arguments: { id: "northwind" },
      },
      owner(),
    );
    expect((await activityRows())[0]).toMatchObject({
      tool: { name: "everyapp_provider_remove", via: "everyapp_call_write" },
      user: { id: ownerId },
      decision: "allowed",
      outcome: "ok",
    });
  });
});
