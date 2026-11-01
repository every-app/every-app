/**
 * Fill a LOCAL gateway's database with every state the UI has: an owner,
 * an admin, members (one deactivated, one with a very long name), pending
 * invitations, a second organization, apps in every deploy state (and
 * with --many, a long catalog), apps that need setup (a Gateway setting
 * unset, an any-of group, an app-held secret the CLI recorded as unset), a
 * provider app, groups (empty, one member, many members), access grants
 * direct and through groups, monthly caps (a workspace default, an app
 * under its own cap, one paused through the default, one unlimited), AI
 * connections, personal access tokens (active, expired, revoked), a month
 * of usage, an agent-activity trail with and without the AI client's
 * handshake name, and the event bus: a webhook subscription with
 * delivered, failed and dead deliveries, the built-in Cap alerts email
 * subscription (dead: no mail locally), and a dozen events. For
 * screenshots and design review; nothing here is for production.
 *
 * "Needs setup" depends on the gateway's own .dev.vars: with
 * OPENROUTER_API_KEY and DATAFORSEO_API_KEY set to any value OpenSEO and
 * the DataForSEO provider app read as ready and Research Desk needs only
 * its own MAIN_SECRET; without them they need setup too. OpenMail
 * always needs setup (email and Slack are never configured locally).
 *
 * Run `pnpm db:migrate:local`, start the gateway, claim the owner from
 * `pnpm setup-link`, then:
 *
 *   node scripts/seed-local.mjs [--many] [--reset]
 *
 * Seeded rows have ids starting with "seed-", except apps and tokens, whose
 * ids the gateway requires to be UUIDs, and groups and the event bus's
 * rows, which have the gateway's own prefixed shapes: theirs are derived
 * from their names, so they are the same on every run. A second run replaces everything, and
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
/** A group id in the gateway's own shape, `grp_` and 16 hex characters. */
const groupId = (key) =>
  `grp_${createHash("sha1").update(`every-app-seed:group-${key}`).digest("hex").slice(0, 16)}`;
/** `<prefix>_` and 24 hex characters, the gateway's subscription and delivery shape. */
const prefixedHex = (prefix, key) =>
  `${prefix}_${createHash("sha1").update(`every-app-seed:${prefix}-${key}`).digest("hex").slice(0, 24)}`;
const subscriptionId = (key) => prefixedHex("sub", key);
const deliveryId = (key) => prefixedHex("dlv", key);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * An event id as the gateway makes one (`evt_`, ten characters of time,
 * sixteen of randomness): the time is the event's, the rest derived from
 * the key, so a reseed finds last run's rows by that tail.
 */
const eventIdTail = (key) =>
  [...createHash("sha1").update(`every-app-seed:event-${key}`).digest()]
    .slice(0, 16)
    .map((byte) => CROCKFORD[byte % 32])
    .join("");
function eventId(key, ms) {
  let time = "";
  for (let value = ms, index = 0; index < 10; index += 1) {
    time = CROCKFORD[value % 32] + time;
    value = Math.floor(value / 32);
  }
  return `evt_${time}${eventIdTail(key)}`;
}
const SUBSCRIPTION_KEYS = ["slack", "cap-alerts"];
const EVENT_KEYS = [
  "invited",
  "joined",
  "role",
  "installed",
  "updated",
  "needs-setup",
  "blocked",
  "token",
  "warning",
  "reached",
  "paused",
  "deal-won",
];
const SEED_SUBSCRIPTION_IDS = SUBSCRIPTION_KEYS.map(subscriptionId);
const SEED_EVENT_TAILS = EVENT_KEYS.map(eventIdTail);
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
  "research",
  "provider-dataforseo",
  ...Array.from({ length: 20 }, (_, index) => `many-${index + 1}`),
];
const TOKEN_KEYS = [
  "claude-code",
  "cursor-openseo",
  "expired",
  "revoked",
  "old",
];
const GROUP_KEYS = ["sales", "engineering", "empty", "long"];
const SEED_APP_IDS = APP_KEYS.map(appId);
const SEED_TOKEN_IDS = TOKEN_KEYS.map(tokenId);
const SEED_GROUP_IDS = GROUP_KEYS.map(groupId);
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
    [
      "event_deliveries",
      `subscription_id IN (${inList(SEED_SUBSCRIPTION_IDS)})`,
      SEED_SUBSCRIPTION_IDS,
    ],
    [
      "event_subscriptions",
      `id IN (${inList(SEED_SUBSCRIPTION_IDS)})`,
      SEED_SUBSCRIPTION_IDS,
    ],
    [
      "events",
      `substr(id, 15) IN (${inList(SEED_EVENT_TAILS)})`,
      SEED_EVENT_TAILS,
    ],
    ["mcp_tool_calls", "id LIKE 'seed-%'"],
    ["usage_daily", apps, SEED_APP_IDS],
    ["usage_monthly", apps, SEED_APP_IDS],
    ["app_tools", apps, SEED_APP_IDS],
    ["app_tool_catalogs", apps, SEED_APP_IDS],
    ["mcp_connection_apps", "connection_id LIKE 'seed-%'"],
    ["mcp_connections", "id LIKE 'seed-%'"],
    [
      "group_app_access",
      `group_id IN (${inList(SEED_GROUP_IDS)})`,
      SEED_GROUP_IDS,
    ],
    [
      "group_members",
      `group_id IN (${inList(SEED_GROUP_IDS)})`,
      SEED_GROUP_IDS,
    ],
    ["groups", `id IN (${inList(SEED_GROUP_IDS)})`, SEED_GROUP_IDS],
    ["org_app_settings", apps, SEED_APP_IDS],
    // The default of every organization the seed members belong to (org A
    // is the claimed owner's, so its id is not "seed-"); before `members`.
    [
      "org_settings",
      "organization_id IN (SELECT organization_id FROM members WHERE id LIKE 'seed-%')",
    ],
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
      name: "OpenMail",
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
      // Needs setup for a secret of its own: the CLI recorded the Worker's
      // secret names and MAIN_SECRET isn't among them. One AI model of two
      // is enough (an any-of group), and two settings are optional.
      id: appId("research"),
      slug: "research",
      name: "Research Desk",
      description: "Long-form research reports drafted by an agent.",
      hostname: "research.apps.example.com",
      status: "active",
      isDefault: true,
      manifest: manifest("research", {
        providers: [
          { id: "openrouter", anyOf: "AI model" },
          { id: "workers-ai", anyOf: "AI model" },
        ],
        capabilities: {
          context: {
            access: "read",
            optional: true,
            why: "Renders JavaScript pages in audits.",
          },
        },
        secrets: [
          {
            name: "MAIN_SECRET",
            why: "Signs the links reports are shared by.",
          },
          {
            name: "WEBHOOK_SECRET",
            optional: true,
            why: "Verifies inbound webhooks.",
          },
        ],
      }),
      secretNames: JSON.stringify(["WEBHOOK_SECRET_OLD"]),
      deployedBy: "ben@example.com",
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
      "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, email_senders, email_inbound, secret_names, status, version_id, deployed_at, deployed_by_actor, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'service_binding', 'org', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        app.secretNames ?? null,
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

  // The DataForSEO provider app, as `everyapp provider on dataforseo`
  // writes it (@every-app/sdk/internal providerApps.ts, hardcoded here):
  // tier "provider", no hostname or Worker, active from the start, never
  // the organization's default; owners and admins get it. It reads "AI
  // tools" once DATAFORSEO_API_KEY is set on the gateway, "Needs setup"
  // until then.
  const providerManifest = {
    id: "dataforseo",
    name: "DataForSEO",
    description:
      "SEO data for your agent: keyword metrics and suggestions, live Google results, domain rankings, competitors and backlinks, through the Gateway's DataForSEO key.",
    capabilities: {
      dataforseo: {
        access: "read",
        why: "Serves DataForSEO's keyword, search-result, domain and backlink data to members' AI clients.",
      },
    },
  };
  await run(
    "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, version_id, deployed_at, deployed_by_actor, is_default, created_at, updated_at) VALUES (?, ?, 'dataforseo', 'DataForSEO', ?, NULL, NULL, 'provider', 'org', ?, 'active', NULL, ?, 'ben@example.com', 0, ?, ?)",
    [
      appId("provider-dataforseo"),
      orgA,
      providerManifest.description,
      JSON.stringify(providerManifest),
      ago(2 * DAY),
      ago(2 * DAY),
      ago(2 * DAY),
    ],
  );

  // A tombstone keeps no grants (AppRepository.tombstone).
  const live = apps
    .filter((app) => app.status !== "deleted")
    .map((app) => app.id)
    .concat(appId("provider-dataforseo"));
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

  // Groups: many members (one deactivated), one member, none; apps
  // granted through them, including ones the members also hold directly.
  const groups = [
    {
      id: groupId("sales"),
      name: "Sales",
      description: "Everyone on the sales team.",
      members: [
        ownerId,
        "seed-user-admin",
        "seed-user-member",
        "seed-user-long",
        "seed-user-plain",
        "seed-user-banned",
      ],
      apps: [appId("crm"), appId("reports")],
      createdAt: ago(14 * DAY),
    },
    {
      id: groupId("engineering"),
      name: "Engineering",
      description: null,
      members: ["seed-user-member"],
      apps: [appId("openseo"), appId("analytics"), appId("research")],
      createdAt: ago(7 * DAY),
    },
    {
      id: groupId("empty"),
      name: "Contractors",
      description: "Made before anyone joined it; nothing granted yet.",
      members: [],
      apps: [],
      createdAt: ago(HOUR),
    },
    {
      id: groupId("long"),
      name: "Regional partner managers, EMEA and APAC, and delegates",
      description:
        "This description is long on purpose so that the Group column has to truncate it instead of wrapping under the counts.",
      members: ["seed-user-long"],
      apps: [appId("long")],
      createdAt: ago(3 * DAY),
    },
  ];
  for (const group of groups) {
    await run(
      "INSERT INTO groups (id, organization_id, name, description, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      [group.id, orgA, group.name, group.description, group.createdAt, ownerId],
    );
    for (const userId of group.members) {
      await run(
        "INSERT INTO group_members (group_id, user_id, organization_id, added_at, added_by) VALUES (?, ?, ?, ?, ?)",
        [group.id, userId, orgA, group.createdAt + HOUR, ownerId],
      );
    }
    for (const app of group.apps) {
      await run(
        "INSERT INTO group_app_access (group_id, app_row_id, organization_id, granted_at, granted_by) VALUES (?, ?, ?, ?, ?)",
        [group.id, app, orgA, group.createdAt + 2 * HOUR, ownerId],
      );
    }
  }

  // Monthly caps (Manage workspace → Usage): a workspace default of 1,000
  // for every app without a row; OpenSEO well under its own cap, the
  // provider app under a small one, the CRM unlimited whatever the
  // default, and the inbox with no row of its own past the default (the
  // gateway refuses its calls and the launcher says Paused: the cap check
  // reads the usage_monthly rows written below).
  await run(
    "INSERT INTO org_settings (organization_id, default_monthly_call_cap, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    [orgA, 1_000, ago(2 * DAY), ownerId],
  );
  for (const [app, cap, unlimited, by] of [
    [appId("openseo"), 5_000, 0, ownerId],
    [appId("provider-dataforseo"), 500, 0, ownerId],
    [appId("crm"), null, 1, "seed-user-admin"],
  ]) {
    await run(
      "INSERT INTO org_app_settings (organization_id, app_row_id, monthly_call_cap, unlimited, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
      [orgA, app, cap, unlimited, ago(DAY), by],
    );
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
      name: "Work laptop",
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
    [
      appId("provider-dataforseo"),
      ownerId,
      "capability",
      "dataforseo",
      96,
      2,
      0,
      0,
      480_000,
    ],
  ];
  // The month's totals are the same whatever the day: the calls spread over
  // the days of the month so far, up to four of them.
  const dayOfMonth = new Date(now).getUTCDate();
  const daysBack = [0, 1, 2, 5].filter((back) => back < dayOfMonth);
  const monthly = new Map();
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
    const share = (total) => Math.ceil(total / daysBack.length);
    for (const back of daysBack) {
      const at = ago(back * DAY);
      await run(
        "INSERT INTO usage_daily (organization_id, app_row_id, user_id, kind, target, day, calls, failures, input_tokens, output_tokens, cost_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          orgA,
          app,
          userId,
          kind,
          target,
          day(at),
          share(calls),
          share(failures),
          share(input),
          share(output),
          share(cost),
          at,
        ],
      );
      // The month's row per app, which the cap check reads (app-cap.ts).
      const sum = monthly.get(app) ?? {
        calls: 0,
        failures: 0,
        input: 0,
        output: 0,
        cost: 0,
      };
      sum.calls += share(calls);
      sum.failures += share(failures);
      sum.input += share(input);
      sum.output += share(output);
      sum.cost += share(cost);
      monthly.set(app, sum);
    }
  }
  for (const [app, sum] of monthly) {
    await run(
      "INSERT INTO usage_monthly (organization_id, app_row_id, month, calls, failures, input_tokens, output_tokens, cost_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        orgA,
        app,
        day(now).slice(0, 7),
        sum.calls,
        sum.failures,
        sum.input,
        sum.output,
        sum.cost,
        now,
      ],
    );
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
    [
      "seed-call-12",
      "seed-user-admin",
      "access",
      // An Access caller's credential id is their email.
      "admin@example.com",
      null,
      "gateway",
      appId("openseo"),
      "openseo",
      "research_keywords",
      "read",
      "allowed",
      null,
      "ok",
      512,
      9_800,
      ago(50 * 60 * 1000),
    ],
    [
      "seed-call-13",
      ownerId,
      "oauth",
      "seed-mcpc-claude",
      "Claude",
      "gateway",
      appId("provider-dataforseo"),
      "dataforseo",
      "keyword_overview",
      "read",
      "allowed",
      null,
      "ok",
      1_240,
      31_000,
      ago(8 * 60 * 1000),
    ],
  ];
  // What the AI client called itself in the MCP handshake (never
  // verified); null for a client that sent none, as 2025-era ones may.
  const clientInfo = {
    "seed-call-1": "Claude Desktop 1.4.0",
    "seed-call-4": "claude-code 2.1.309",
    "seed-call-6": "Cursor 1.7.2",
    "seed-call-9": "Claude Desktop 1.4.0",
    "seed-call-12": "Codex CLI 0.48.0",
    "seed-call-13": "Claude Desktop 1.4.0",
  };
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
      "INSERT INTO mcp_tool_calls (id, created_at, organization_id, user_id, credential_kind, credential_id, client_name, client_info, surface, app_row_id, app_slug, tool_name, risk, decision, reason, outcome, duration_ms, args_digest, result_bytes, protocol_version, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '2026-07-28', NULL)",
      [
        id,
        createdAt,
        orgA,
        userId,
        kind,
        credentialId,
        clientName,
        clientInfo[id] ?? null,
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

  const bus = await seedEvents({
    orgA,
    ownerId,
    ownerName: String(owner.name),
  });

  console.log(
    `Seeded ${users.length} users, ${invitations.length} invitations, ${apps.length + 2} apps (one a provider app), ${groups.length} groups, ${connections.length} connections, ${tokens.length} tokens, ${calls.length} tool calls, ${bus.subscriptions} event subscriptions, ${bus.events} events and ${bus.deliveries} deliveries into ${orgA} (Acme Corp) and ${orgB} (Northwind Traders).`,
  );
}

/**
 * Manage workspace → Events: "Slack #ops", a webhook taking member and
 * cap events, blocked tool calls, installs and updates, and crm's own
 * events (not app.needs_setup, which the local gateway emits for real the
 * first time it reads the seeded apps), whose deliveries were mostly
 * delivered, one dead after its seventh attempt, one redelivered, and the
 * two latest failing (retried, two failures in a row); and the built-in
 * "Cap alerts" email subscription the inbox's cap created, dead twice
 * because a local gateway can't send mail. The events are a dozen of the
 * catalogue's over the last two days and one of an app's own
 * (app.crm.deal.won), with the data the catalogue's builders write, so
 * the summaries and payloads read as real ones. Never a real secret: the
 * webhook's is a placeholder.
 */
async function seedEvents({ orgA, ownerId, ownerName }) {
  const MINUTE = 60 * 1000;
  const owner = { kind: "user", id: ownerId, name: ownerName };
  const admin = {
    id: "seed-user-admin",
    email: "admin@example.com",
    name: "Alex Admin",
  };
  const member = {
    id: "seed-user-member",
    email: "member@example.com",
    name: "Morgan Member",
  };
  const sam = {
    id: "seed-user-plain",
    email: "sam@example.com",
    name: "sam@example.com",
  };
  const app = (key, name) => ({ id: key, rowId: appId(key), name });
  const crm = app("crm", "Open CRM");
  const inbox = app("inbox", "OpenMail");
  const month = new Date(now).toISOString().slice(0, 7);
  const gateway = { kind: "gateway" };
  const events = [
    [
      "invited",
      "member.invited",
      ago(46 * HOUR),
      owner,
      {
        invitation: {
          id: "seed-inv-1",
          email: "invitee@example.com",
          role: "member",
          expiresAt: new Date(ago(46 * HOUR) + 72 * HOUR).toISOString(),
        },
        emailSent: false,
      },
    ],
    [
      "joined",
      "member.joined",
      ago(40 * HOUR),
      { kind: "user", ...sam },
      { user: sam, role: "member", via: "invitation" },
    ],
    [
      "role",
      "member.role_changed",
      ago(30 * HOUR),
      owner,
      { user: admin, role: "admin", previousRole: "member" },
    ],
    [
      "installed",
      "app.installed",
      ago(26 * HOUR),
      { kind: "operator", id: "ben@example.com" },
      {
        app: crm,
        version: "4f1c2a9e",
        hostname: "crm.apps.example.com",
        scope: "org",
        source: "cli",
      },
    ],
    [
      "updated",
      "app.updated",
      ago(20 * HOUR),
      { kind: "operator", id: "ben@example.com" },
      {
        app: app("openseo", "OpenSEO"),
        version: "9b07d3c1",
        previousVersion: "51e0aa42",
      },
    ],
    [
      "needs-setup",
      "app.needs_setup",
      ago(19 * HOUR),
      gateway,
      { app: inbox, unmet: ["EMAIL_FROM"] },
    ],
    [
      "blocked",
      "tool.blocked",
      ago(8 * HOUR),
      { kind: "agent", id: "seed-mcpc-claude", name: "Claude" },
      {
        tool: "crm_delete_contact",
        app: crm,
        user: member,
        client: { kind: "oauth", name: "Claude", id: "seed-mcpc-claude" },
        risk: "destructive",
        reason: "destructive_requires_approval",
        callId: "seed-call-3",
      },
    ],
    [
      "token",
      "token.created",
      ago(6 * HOUR),
      owner,
      {
        id: tokenId("claude-code"),
        name: "Claude Code on MacBook",
        scopes: ["mcp"],
        user: { id: ownerId, name: ownerName },
      },
    ],
    [
      "warning",
      "cap.warning",
      ago(4 * HOUR),
      gateway,
      {
        app: inbox,
        kind: "calls",
        cap: 1000,
        calls: 800,
        month,
        threshold: 80,
        source: "app",
      },
    ],
    [
      "reached",
      "cap.reached",
      ago(2 * HOUR),
      gateway,
      {
        app: inbox,
        kind: "calls",
        cap: 1000,
        calls: 1000,
        month,
        source: "app",
      },
    ],
    [
      "paused",
      "app.paused_cap",
      ago(2 * HOUR),
      gateway,
      {
        app: inbox,
        kind: "calls",
        cap: 1000,
        calls: 1000,
        month,
        source: "app",
      },
    ],
    [
      "deal-won",
      "app.crm.deal.won",
      ago(30 * MINUTE),
      { kind: "user", ...member },
      {
        dealId: "deal_42",
        account: "Northwind Traders",
        amount: 12000,
        currency: "USD",
      },
    ],
  ];
  const ids = new Map();
  for (const [key, type, time, actor, data] of events) {
    const id = eventId(key, time);
    ids.set(key, { id, time });
    await run(
      "INSERT INTO events (id, organization_id, type, version, time, actor, data, app_row_id, dedupe_key, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?)",
      [
        id,
        orgA,
        type,
        time,
        JSON.stringify(actor),
        JSON.stringify(data),
        data.app?.rowId ?? (type.startsWith("app.crm.") ? appId("crm") : null),
        time,
      ],
    );
  }

  const slack = subscriptionId("slack");
  const capAlerts = subscriptionId("cap-alerts");
  const latestAttempt = ago(2 * MINUTE);
  await run(
    "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, recipients, events, enabled, builtin, description, created_at, updated_at, created_by, last_delivery_at, last_delivery_status, consecutive_failures) VALUES (?, ?, 'Slack #ops', 'webhook', 'https://hooks.example.com/everyapp', 'whsec_seed-placeholder-not-a-real-secret', NULL, ?, 1, NULL, NULL, ?, ?, ?, ?, 'failed', 2)",
    [
      slack,
      orgA,
      JSON.stringify([
        "member.*",
        "cap.*",
        "tool.blocked",
        "app.installed",
        "app.updated",
        "app.crm.*",
      ]),
      ago(3 * DAY),
      ago(3 * DAY),
      ownerId,
      latestAttempt,
    ],
  );
  await run(
    "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, recipients, events, enabled, builtin, description, created_at, updated_at, created_by, last_delivery_at, last_delivery_status, consecutive_failures) VALUES (?, ?, 'Cap alerts', 'email', NULL, NULL, 'admins', ?, 1, 'cap_alerts', 'Owners and admins get an email at 80% and at the cap.', ?, ?, NULL, ?, 'dead', 2)",
    [
      capAlerts,
      orgA,
      JSON.stringify(["cap.warning", "cap.reached"]),
      ago(DAY),
      ago(DAY),
      ids.get("reached").time + 1000,
    ],
  );

  // [event, subscription, outcome]: delivered at the first attempt unless
  // it says otherwise.
  const deliveries = [
    ["invited", slack, "delivered"],
    ["joined", slack, "dead"],
    ["role", slack, "delivered"],
    ["installed", slack, "delivered"],
    ["updated", slack, "redelivered"],
    ["blocked", slack, "delivered"],
    ["warning", slack, "delivered"],
    ["reached", slack, "failed"],
    ["deal-won", slack, "failed"],
    ["warning", capAlerts, "no-mail"],
    ["reached", capAlerts, "no-mail"],
  ];
  for (const [key, subscription, outcome] of deliveries) {
    const { id: event, time } = ids.get(key);
    const first = time + 400;
    const row = {
      delivered: ["delivered", 1, null, first, 200, null, first, null],
      redelivered: [
        "delivered",
        1,
        null,
        time + 3 * HOUR,
        200,
        null,
        time + 3 * HOUR,
        time + 3 * HOUR,
      ],
      dead: ["dead", 7, null, time + 35 * HOUR, null, "timeout", null, null],
      failed: [
        "pending",
        2,
        latestAttempt + 25 * MINUTE,
        latestAttempt,
        503,
        "status_503: Service Unavailable",
        null,
        null,
      ],
      "no-mail": [
        "dead",
        1,
        null,
        first,
        null,
        "email_not_configured",
        null,
        null,
      ],
    }[outcome];
    const [
      status,
      attempts,
      nextAttemptAt,
      lastAttemptAt,
      statusCode,
      error,
      deliveredAt,
      redeliveredAt,
    ] = row;
    await run(
      "INSERT INTO event_deliveries (id, event_id, subscription_id, organization_id, status, attempts, next_attempt_at, claimed_until, last_attempt_at, last_status_code, last_error, delivered_at, redelivered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
      [
        deliveryId(`${key}-${subscription}`),
        event,
        subscription,
        orgA,
        status,
        attempts,
        nextAttemptAt,
        lastAttemptAt,
        statusCode,
        error,
        deliveredAt,
        redeliveredAt,
        time,
      ],
    );
  }
  return {
    subscriptions: 2,
    events: events.length,
    deliveries: deliveries.length,
  };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => db.close());
