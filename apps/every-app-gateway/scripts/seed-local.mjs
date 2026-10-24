/**
 * Fill a LOCAL gateway's database with every state the UI has: an owner,
 * an admin, members (one deactivated, one with a very long name), pending
 * invitations, a second organization, apps in every deploy state (and
 * with --many, a long catalog), access grants, AI connections, personal
 * access tokens (active, expired, revoked), a month of usage and an
 * agent-activity trail. For screenshots and design review; nothing here
 * is for production.
 *
 * Run `pnpm db:migrate:local`, start the gateway, claim the owner from
 * `pnpm setup-link`, then:
 *
 *   node scripts/seed-local.mjs [--many] [--reset]
 *
 * Seeded rows have ids starting with "seed-", except apps and tokens, whose
 * ids the gateway requires to be UUIDs: theirs are derived from their names,
 * so they are the same on every run. A second run replaces everything, and
 * --reset only removes it. Passwords: everyone is "password-<role>-1"
 * (admin@example.com is password-admin-1, member@example.com is
 * password-member-1).
 *
 * Two things the UI will not show from this data alone. "Deleted App" is a
 * tombstone and is never listed anywhere. The AI connections have no OAuth
 * grant behind them, and Settings > Connections ends any connection older
 * than five minutes without one, so they appear in the admin activity trail
 * but not on that page; to see a live connection there, connect a real
 * client, or run scripts/mcp-oauth-local.mjs against the same gateway.
 */
import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const GATEWAY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const D1_DIR = path.join(
  GATEWAY_DIR,
  ".cloudflare/state/v3/d1/miniflare-D1DatabaseObject",
);

const { values: args } = parseArgs({
  options: {
    many: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
  },
});

const file = readdirSync(D1_DIR).find(
  (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
);
if (!file) {
  console.error("No local D1 database: run `pnpm db:migrate:local` first.");
  process.exit(1);
}
const db = createClient({ url: `file:${path.join(D1_DIR, file)}` });

/** A UUID (version 5 shape) that is the same every run for the same name. */
function seedUuid(name) {
  const hex = createHash("sha1").update(`every-app-seed:${name}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const appId = (key) => seedUuid(`app-${key}`);
const tokenId = (key) => seedUuid(`pat-${key}`);
const APP_KEYS = [
  "openseo",
  "inbox",
  "crm",
  "analytics",
  "todo",
  "reports",
  "long",
  "deleted",
  "wiki",
  "removed",
  ...Array.from({ length: 20 }, (_, index) => `many-${index + 1}`),
];
const TOKEN_KEYS = [
  "claude-code",
  "cursor-openseo",
  "expired",
  "revoked",
  "old",
];
const SEED_APP_IDS = APP_KEYS.map(appId);
const SEED_TOKEN_IDS = TOKEN_KEYS.map(tokenId);
const inList = (ids) => ids.map(() => "?").join(", ");

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => now - ms;
const day = (date) => new Date(date).toISOString().slice(0, 10);

async function run(sql, params = []) {
  await db.execute({ sql, args: params });
}

async function reset() {
  const apps = `app_row_id IN (${inList(SEED_APP_IDS)})`;
  const tables = [
    ["mcp_tool_calls", "id LIKE 'seed-%'"],
    ["usage_daily", apps, SEED_APP_IDS],
    ["usage_monthly", apps, SEED_APP_IDS],
    ["app_tools", apps, SEED_APP_IDS],
    ["app_tool_catalogs", apps, SEED_APP_IDS],
    ["mcp_connection_apps", "connection_id LIKE 'seed-%'"],
    ["mcp_connections", "id LIKE 'seed-%'"],
    ["user_access_tokens", `id IN (${inList(SEED_TOKEN_IDS)})`, SEED_TOKEN_IDS],
    ["user_app_access", "id LIKE 'seed-%'"],
    ["invitations", "id LIKE 'seed-%'"],
    ["apps", `id IN (${inList(SEED_APP_IDS)})`, SEED_APP_IDS],
    ["members", "id LIKE 'seed-%'"],
    ["sessions", "user_id LIKE 'seed-%'"],
    ["accounts", "id LIKE 'seed-%'"],
    ["users", "id LIKE 'seed-%'"],
    ["organizations", "id LIKE 'seed-%'"],
  ];
  for (const [table, where, params] of tables) {
    await run(`DELETE FROM ${table} WHERE ${where}`, params);
  }
}

async function main() {
  await reset();
  if (args.reset) {
    console.log("Removed the seeded rows.");
    return;
  }

  const owner = (
    await db.execute(
      "SELECT u.id, u.name, m.organization_id FROM users u JOIN members m ON m.user_id = u.id WHERE m.role = 'owner' ORDER BY m.created_at LIMIT 1",
    )
  ).rows[0];
  if (!owner) {
    console.error("No owner yet: open the link `pnpm setup-link` prints.");
    process.exit(1);
  }
  const ownerId = String(owner.id);
  const orgA = String(owner.organization_id);
  await run("UPDATE organizations SET name = ?, slug = ? WHERE id = ?", [
    "Acme Corp",
    "acme",
    orgA,
  ]);

  // A second organization: the admin owns it, the owner is a plain member.
  const orgB = "seed-org-northwind";
  await run(
    "INSERT INTO organizations (id, name, slug, logo, created_at, metadata, status) VALUES (?, ?, ?, NULL, ?, NULL, 'active')",
    [orgB, "Northwind Traders", "northwind", ago(40 * DAY)],
  );

  const users = [
    {
      id: "seed-user-admin",
      name: "Alex Admin",
      email: "admin@example.com",
      password: "password-admin-1",
      roles: { [orgA]: "admin", [orgB]: "owner" },
      createdAt: ago(30 * DAY),
    },
    {
      id: "seed-user-member",
      name: "Morgan Member",
      email: "member@example.com",
      password: "password-member-1",
      roles: { [orgA]: "member" },
      createdAt: ago(20 * DAY),
    },
    {
      id: "seed-user-long",
      name: "Maximilian Alexander Bartholomew Fitzgerald-Montgomery the Third",
      email:
        "maximilian.alexander.bartholomew@very-long-company-domain-name.example.com",
      password: "password-member-1",
      roles: { [orgA]: "member" },
      createdAt: ago(12 * DAY),
    },
    {
      id: "seed-user-plain",
      name: "sam@example.com",
      email: "sam@example.com",
      password: "password-member-1",
      roles: { [orgA]: "member" },
      createdAt: ago(5 * DAY),
    },
    {
      id: "seed-user-banned",
      name: "Taylor Former",
      email: "taylor@example.com",
      password: "password-member-1",
      roles: { [orgA]: "member" },
      banned: true,
      createdAt: ago(60 * DAY),
    },
  ];
  for (const user of users) {
    await run(
      "INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires, status) VALUES (?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, NULL, 'active')",
      [
        user.id,
        user.name,
        user.email,
        user.createdAt,
        user.createdAt,
        user.banned ? 1 : 0,
        user.banned ? "Deactivated by an admin" : null,
      ],
    );
    await run(
      "INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?, ?, 'credential', ?, ?, ?, ?)",
      [
        `seed-account-${user.id}`,
        user.id,
        user.id,
        await hashPassword(user.password),
        user.createdAt,
        user.createdAt,
      ],
    );
    for (const [organizationId, role] of Object.entries(user.roles)) {
      await run(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          `seed-member-${user.id}-${organizationId}`,
          organizationId,
          user.id,
          role,
          user.createdAt,
        ],
      );
    }
  }
  await run(
    "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    [`seed-member-owner-${orgB}`, orgB, ownerId, ago(39 * DAY)],
  );

  const invitations = [
    ["seed-inv-1", "invitee@example.com", "member", ago(2 * HOUR)],
    [
      "seed-inv-2",
      "jordan.alexander-whitfield@very-long-company-domain-name.example.com",
      "admin",
      ago(3 * DAY),
    ],
  ];
  for (const [id, email, role, createdAt] of invitations) {
    await run(
      "INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      [id, orgA, email, role, createdAt + 72 * HOUR, createdAt, ownerId],
    );
  }

  const manifest = (id, extra = {}) =>
    JSON.stringify({ id, resources: { d1: ["DB"] }, ...extra });
  const apps = [
    {
      id: appId("openseo"),
      slug: "openseo",
      name: "OpenSEO",
      description:
        "Keyword research, rank tracking, site audits and AI visibility for your sites.",
      hostname: "openseo.apps.example.com",
      status: "active",
      isDefault: true,
      manifest: manifest("openseo", {
        providers: ["openrouter"],
        capabilities: {
          dataforseo: { access: "read", why: "Keyword and SERP data." },
        },
      }),
      deployedBy: "ben@example.com",
    },
    {
      id: appId("inbox"),
      slug: "inbox",
      name: "Agentic Inbox",
      description: "A shared inbox that drafts replies for you.",
      hostname: "inbox.apps.example.com",
      status: "active",
      isDefault: true,
      manifest: manifest("inbox", {
        capabilities: {
          email: { access: "write", why: "Sends and receives mail." },
          slack: { access: "write", why: "Posts digests." },
        },
      }),
      emailSenders: JSON.stringify(["hi@example.com"]),
      emailInbound: JSON.stringify(["support@example.com"]),
      deployedBy: "ben@example.com",
    },
    {
      id: appId("crm"),
      slug: "crm",
      name: "Open CRM",
      description: "Contacts, deals and notes.",
      hostname: "crm.apps.example.com",
      status: "active",
      isDefault: false,
      deployedBy: "api-token:0123456789abcdef",
    },
    {
      id: appId("analytics"),
      slug: "analytics",
      name: "Open Analytics",
      description: "Privacy-friendly web analytics.",
      hostname: "analytics.apps.example.com",
      status: "binding",
      isDefault: true,
    },
    {
      id: appId("todo"),
      slug: "todo",
      name: "Todo",
      description: "The starter app.",
      hostname: null,
      status: "pending",
      isDefault: false,
    },
    {
      id: appId("reports"),
      slug: "reports",
      name: "Quarterly Reports Archive",
      description: "Old reports, kept for reference.",
      hostname: "reports.apps.example.com",
      status: "disabled",
      isDefault: false,
    },
    {
      id: appId("long"),
      slug: "very-long-app-name",
      name: "A Very Long App Name That Keeps Going To Test Truncation In Cards And Lists",
      description:
        "This description is also long, on purpose, so that the card has to clamp it after two lines and the list view has to truncate it with an ellipsis instead of pushing the row taller than its neighbours or wrapping under the actions.",
      hostname: "very-long-app-name.apps.example.com",
      status: "active",
      isDefault: true,
    },
    {
      id: appId("deleted"),
      slug: "deleted",
      name: "Deleted App",
      description: "A tombstone: never listed.",
      hostname: null,
      status: "deleted",
      isDefault: false,
    },
  ];
  if (args.many) {
    for (let index = 1; index <= 20; index += 1) {
      apps.push({
        id: appId(`many-${index}`),
        slug: `tool-${index}`,
        name: `Workspace Tool ${index}`,
        description: `Internal tool number ${index}.`,
        hostname: `tool-${index}.apps.example.com`,
        status: "active",
        isDefault: true,
      });
    }
  }
  for (const [index, app] of apps.entries()) {
    const createdAt = ago((apps.length - index) * DAY);
    await run(
      "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, email_senders, email_inbound, status, version_id, deployed_at, deployed_by_actor, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'service_binding', 'org', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        app.id,
        orgA,
        app.slug,
        app.name,
        app.description,
        app.hostname,
        app.hostname ? `every-acme-${app.slug}` : null,
        app.manifest ?? manifest(app.slug),
        app.emailSenders ?? null,
        app.emailInbound ?? null,
        app.status,
        app.hostname ? `seed-version-${app.slug}` : null,
        app.hostname ? createdAt : null,
        app.deployedBy ?? null,
        app.isDefault ? 1 : 0,
        createdAt,
        createdAt + HOUR,
      ],
    );
  }
  // Northwind's own app, for the switcher and the consent page.
  await run(
    "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, version_id, deployed_at, is_default, created_at, updated_at) VALUES (?, ?, 'wiki', 'Northwind Wiki', 'Internal documentation.', 'wiki.apps.example.com', 'every-northwind-wiki', 'service_binding', 'org', ?, 'active', 'seed-version-wiki', ?, 1, ?, ?)",
    [
      appId("wiki"),
      orgB,
      manifest("wiki"),
      ago(10 * DAY),
      ago(10 * DAY),
      ago(10 * DAY),
    ],
  );

  // A tombstone keeps no grants (AppRepository.tombstone).
  const live = apps
    .filter((app) => app.status !== "deleted")
    .map((app) => app.id);
  const grants = [
    [ownerId, orgA, live],
    ["seed-user-admin", orgA, live],
    ["seed-user-member", orgA, [appId("openseo"), appId("inbox")]],
    ["seed-user-long", orgA, [appId("openseo")]],
    [ownerId, orgB, [appId("wiki")]],
    ["seed-user-admin", orgB, [appId("wiki")]],
  ];
  for (const [userId, organizationId, appIds] of grants) {
    for (const app of appIds) {
      await run(
        "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id, granted_at, granted_by) VALUES (?, ?, ?, ?, ?, ?)",
        [
          `seed-access-${userId}-${app}`,
          userId,
          app,
          organizationId,
          ago(DAY),
          ownerId,
        ],
      );
    }
  }

  // Tool catalogs: OpenSEO serves tools, the inbox has none yet.
  await run(
    "INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, catalog_hash, tool_count, instructions, sdk_version, warnings, last_error, fetched_at, version_id) VALUES (?, ?, 'ok', 'seed-hash', 3, NULL, '0.3.0', NULL, NULL, ?, 'seed-version-openseo')",
    [appId("openseo"), orgA, ago(HOUR)],
  );
  for (const [name, risk, description] of [
    ["research_keywords", "read", "Find keyword ideas for a topic."],
    ["save_keywords", "write", "Save keywords to a project."],
    ["delete_project", "destructive", "Delete a project and its data."],
  ]) {
    await run(
      "INSERT INTO app_tools (app_row_id, organization_id, name, title, description, risk, input_schema, output_schema, annotations, catalog_hash) VALUES (?, ?, ?, NULL, ?, ?, '{\"type\":\"object\"}', NULL, NULL, 'seed-hash')",
      [appId("openseo"), orgA, name, description, risk],
    );
  }
  await run(
    "INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, catalog_hash, tool_count, fetched_at, version_id) VALUES (?, ?, 'empty', NULL, 0, ?, 'seed-version-inbox')",
    [appId("inbox"), orgA, ago(HOUR)],
  );

  const connections = [
    {
      id: "seed-mcpc-claude",
      userId: ownerId,
      organizationId: orgA,
      clientName: "Claude",
      clientDomain: "claude.ai",
      redirectHost: "claude.ai",
      appScope: "all",
      access: "write",
      createdAt: ago(9 * DAY),
      lastUsedAt: ago(2 * HOUR),
    },
    {
      id: "seed-mcpc-cursor",
      userId: ownerId,
      organizationId: orgA,
      clientName: "Cursor",
      clientDomain: null,
      redirectHost: "localhost",
      appScope: "selected",
      access: "read",
      apps: [appId("openseo"), appId("crm")],
      createdAt: ago(3 * DAY),
      lastUsedAt: null,
    },
    {
      id: "seed-mcpc-chatgpt",
      userId: ownerId,
      organizationId: orgB,
      clientName: "ChatGPT",
      clientDomain: "chatgpt.com",
      redirectHost: "openai.com",
      appScope: "all",
      access: "read",
      createdAt: ago(DAY),
      lastUsedAt: ago(DAY),
    },
    {
      id: "seed-mcpc-revoked",
      userId: ownerId,
      organizationId: orgA,
      clientName: "Old Client",
      clientDomain: null,
      redirectHost: "example.com",
      appScope: "all",
      access: "write",
      createdAt: ago(30 * DAY),
      lastUsedAt: ago(20 * DAY),
      revokedAt: ago(15 * DAY),
    },
  ];
  for (const connection of connections) {
    await run(
      "INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, client_domain, redirect_uri, redirect_host, app_scope, access, created_at, last_used_at, revoked_at, revoked_by, revoked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        connection.id,
        connection.userId,
        connection.organizationId,
        `seed-client-${connection.id}`,
        connection.clientName,
        connection.clientDomain,
        `https://${connection.redirectHost}/callback`,
        connection.redirectHost,
        connection.appScope,
        connection.access,
        connection.createdAt,
        connection.lastUsedAt,
        connection.revokedAt ?? null,
        connection.revokedAt ? "user" : null,
        connection.revokedAt ? "user" : null,
      ],
    );
    for (const app of connection.apps ?? []) {
      await run(
        "INSERT INTO mcp_connection_apps (connection_id, app_row_id) VALUES (?, ?)",
        [connection.id, app],
      );
    }
  }

  const tokens = [
    {
      id: tokenId("claude-code"),
      name: "Claude Code on MacBook",
      prefix: "epat_a1b2",
      appId: null,
      scopes: ["mcp:write"],
      createdAt: ago(10 * DAY),
      expiresAt: now + 80 * DAY,
      lastUsedAt: ago(HOUR),
    },
    {
      id: tokenId("cursor-openseo"),
      name: "Cursor (OpenSEO only)",
      prefix: "epat_d4e5",
      appId: appId("openseo"),
      scopes: ["mcp:read"],
      createdAt: ago(4 * DAY),
      expiresAt: now + 26 * DAY,
      lastUsedAt: null,
    },
    {
      id: tokenId("expired"),
      name: "Old laptop",
      prefix: "epat_0918",
      appId: null,
      scopes: ["mcp:write"],
      createdAt: ago(120 * DAY),
      expiresAt: ago(30 * DAY),
      lastUsedAt: ago(45 * DAY),
    },
    {
      id: tokenId("revoked"),
      name: "Shared with a contractor",
      prefix: "epat_fedc",
      appId: null,
      scopes: ["mcp:write"],
      createdAt: ago(50 * DAY),
      expiresAt: now + 40 * DAY,
      lastUsedAt: ago(20 * DAY),
      revokedAt: ago(18 * DAY),
    },
  ];
  for (const token of tokens) {
    await run(
      "INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, scopes, created_at, updated_at, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        token.id,
        ownerId,
        orgA,
        token.appId,
        token.name,
        `seed-hash-${token.name}`,
        token.prefix,
        JSON.stringify(token.scopes),
        token.createdAt,
        token.createdAt,
        token.expiresAt,
        token.revokedAt ?? null,
        token.lastUsedAt,
      ],
    );
  }

  // Usage: this UTC month, several apps, members and providers.
  const usage = [
    [
      appId("openseo"),
      ownerId,
      "ai",
      "openrouter",
      412,
      3,
      1_850_000,
      240_000,
      0,
    ],
    [
      appId("openseo"),
      ownerId,
      "capability",
      "dataforseo",
      96,
      0,
      0,
      0,
      1_240_000,
    ],
    [
      appId("openseo"),
      "seed-user-member",
      "ai",
      "openrouter",
      58,
      1,
      210_000,
      31_000,
      0,
    ],
    [appId("inbox"), "", "ai", "workers-ai", 1_204, 12, 5_400_000, 910_000, 0],
    [appId("inbox"), ownerId, "capability", "email", 37, 0, 0, 0, 0],
    [appId("crm"), "seed-user-admin", "ai", "openai", 15, 0, 48_000, 9_200, 0],
    [appId("crm"), "seed-user-gone", "ai", "openai", 4, 4, 1_000, 0, 0],
  ];
  const daysBack = [0, 1, 2, 5];
  for (const [
    app,
    userId,
    kind,
    target,
    calls,
    failures,
    input,
    output,
    cost,
  ] of usage) {
    for (const back of daysBack) {
      const at = ago(back * DAY);
      if (day(at).slice(0, 7) !== day(now).slice(0, 7)) continue;
      await run(
        "INSERT INTO usage_daily (organization_id, app_row_id, user_id, kind, target, day, calls, failures, input_tokens, output_tokens, cost_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          orgA,
          app,
          userId,
          kind,
          target,
          day(at),
          Math.ceil(calls / 4),
          Math.ceil(failures / 4),
          Math.ceil(input / 4),
          Math.ceil(output / 4),
          Math.ceil(cost / 4),
          at,
        ],
      );
    }
  }

  const calls = [
    [
      "seed-call-1",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("openseo"),
      "openseo",
      "research_keywords",
      "read",
      "allowed",
      null,
      "ok",
      842,
      12_400,
      ago(12 * 60 * 1000),
    ],
    [
      "seed-call-2",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("openseo"),
      "openseo",
      "save_keywords",
      "write",
      "allowed",
      null,
      "ok",
      311,
      220,
      ago(25 * 60 * 1000),
    ],
    [
      "seed-call-3",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("openseo"),
      "openseo",
      "delete_project",
      "destructive",
      "blocked",
      "destructive_tools_hidden",
      "not_run",
      null,
      null,
      ago(40 * 60 * 1000),
    ],
    [
      "seed-call-4",
      ownerId,
      "pat",
      tokenId("claude-code"),
      null,
      "app",
      appId("inbox"),
      "inbox",
      "draft_reply",
      "write",
      "allowed",
      null,
      "tool_error",
      1_930,
      540,
      ago(3 * HOUR),
    ],
    [
      "seed-call-5",
      "seed-user-member",
      "session",
      "session",
      null,
      "gateway",
      appId("openseo"),
      "openseo",
      "research_keywords",
      "read",
      "allowed",
      null,
      "timeout",
      30_000,
      null,
      ago(5 * HOUR),
    ],
    [
      "seed-call-6",
      ownerId,
      "oauth",
      "seed-mcpc-cursor",
      "Cursor",
      "gateway",
      appId("crm"),
      "crm",
      "list_contacts",
      "read",
      "blocked",
      "read_only_caller",
      "not_run",
      null,
      null,
      ago(DAY),
    ],
    [
      "seed-call-7",
      "seed-user-gone",
      "pat",
      tokenId("old"),
      null,
      "gateway",
      appId("removed"),
      "legacy",
      "export_all",
      "read",
      "allowed",
      null,
      "app_error",
      4_100,
      0,
      ago(2 * DAY),
    ],
    [
      "seed-call-8",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      null,
      null,
      "unknown_tool",
      null,
      "blocked",
      "unknown_tool",
      "not_run",
      null,
      null,
      ago(3 * DAY),
    ],
    [
      "seed-call-9",
      "seed-user-admin",
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("openseo"),
      "openseo",
      "research_keywords",
      "read",
      "allowed",
      null,
      "ok",
      655,
      48_912,
      ago(6 * DAY),
    ],
    [
      "seed-call-10",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("inbox"),
      "inbox",
      "send_email",
      "write",
      "allowed",
      null,
      "invalid_arguments",
      12,
      90,
      ago(8 * DAY),
    ],
    [
      "seed-call-11",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("openseo"),
      "openseo",
      "research_keywords",
      "read",
      "allowed",
      null,
      "unreachable",
      10_020,
      null,
      ago(20 * DAY),
    ],
  ];
  for (const [
    id,
    userId,
    kind,
    credentialId,
    clientName,
    surface,
    app,
    slug,
    tool,
    risk,
    decision,
    reason,
    outcome,
    duration,
    bytes,
    createdAt,
  ] of calls) {
    await run(
      "INSERT INTO mcp_tool_calls (id, created_at, organization_id, user_id, credential_kind, credential_id, client_name, surface, app_row_id, app_slug, tool_name, risk, decision, reason, outcome, duration_ms, args_digest, result_bytes, protocol_version, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '2026-07-28', NULL)",
      [
        id,
        createdAt,
        orgA,
        userId,
        kind,
        credentialId,
        clientName,
        surface,
        app,
        slug,
        tool,
        risk,
        decision,
        reason,
        outcome,
        duration,
        bytes,
      ],
    );
  }

  console.log(
    `Seeded ${users.length} users, ${invitations.length} invitations, ${apps.length + 1} apps, ${connections.length} connections, ${tokens.length} tokens, ${calls.length} tool calls into ${orgA} (Acme Corp) and ${orgB} (Northwind Traders).`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => db.close());
