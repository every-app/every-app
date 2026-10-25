/**
 * `everyapp workspace …` end to end, in a fake Cloudflare account with a
 * deployed gateway (as provider/index.test.ts): every verb's happy path
 * and its refusals, against the Gateway's real migrations, and that what
 * the CLI writes is what the Gateway reads: a deactivated row is one
 * isUserBanned refuses, an invite link's token hashes to the stored row
 * findPendingInvitationByToken would accept, a member of two organizations
 * keeps their account when removed from one, and the one rule every write
 * on a member holds: an organization always keeps an owner who can act,
 * which a ban (account-wide) keeps in every organization the person owns.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import * as lib from "@/lib/gateway/workspace";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import {
  listActivity,
  listConnections,
  listTokens,
  reportUsage,
  revokeConnection,
  revokeToken,
} from "./activity";
import { appAccessCommand, listApps, setCap, updateApp } from "./apps";
import {
  createGroup,
  deleteGroup,
  groupAppsCommand,
  groupMembersCommand,
  listGroups,
  updateGroup,
} from "./groups";
import { parseWorkspaceRole } from "./command";
import {
  cancelInvitation,
  deactivateMember,
  inviteMember,
  listUsers,
  newInviteLink,
  passwordResetLink,
  reactivateMember,
  removeMember,
  renameWorkspace,
  setRole,
  showWorkspace,
} from "./index";

const GATEWAY = "every-app-gateway";
const NOW = Date.parse("2026-10-24T12:00:00Z");
const HOUR = 3_600_000;
const ORG = "org-acme";
const OTHER_ORG = "org-beta";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const createCf = vi.fn(() => account.cf);
/** The seams every handler takes: --json, the fake account, a fixed clock. */
const opts = <F extends object>(extra: F = {} as F) => ({
  flags: { ...flags, ...extra },
  out: out(),
  createCf,
  now: () => NOW,
});
const sqlite = () => account.database(GATEWAY);
const rows = (sql: string, ...params: Array<string | number | null>) => sqlite().all(sql, ...params);
const done = () => events.find((event) => event["type"] === "done");
const data = () => done()!["data"] as Record<string, any>;
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** The Gateway's D1 as the lib takes it, for calling the lib without a handler. */
const gatewayD1 = () => cfD1Database(account.cf, [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0]);
/**
 * The write batches sent to D1 since `account.cf.calls` was cleared, one
 * `cf d1 query` call each, by each statement's verb and table: what shows
 * a deactivation or a removal is one request, never a half-applied one.
 */
const writeBatches = () =>
  account.cf.calls
    .filter((call) => call.args[0] === "d1" && call.args[1] === "query")
    .map((call) => {
      const body = JSON.parse(call.files["query.json"]!) as { batch?: Array<{ sql: string }>; sql?: string };
      return (body.batch ?? [body as { sql: string }]).map(
        (statement) => /^(?:UPDATE|DELETE FROM|INSERT INTO|SELECT|PRAGMA) ?\w*/.exec(statement.sql.trim().replace(/\s+/g, " "))![0],
      );
    })
    .filter((batch) => batch.some((statement) => !statement.startsWith("SELECT") && !statement.startsWith("PRAGMA")));

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  seed();
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Two organizations. Acme (the install organization: it has the owner,
 * whose email is the fake login's dev@example.com): an owner, an admin,
 * two members (one also in Beta), two apps and a shared app, a group with
 * a member and an app, a session, two tokens, an AI connection, a pending
 * and an expired invitation, a month of usage and four tool calls.
 */
function seed(): void {
  const db = sqlite().sqlite;
  const exec = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
  exec("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Acme', 'acme', ?)", ORG, NOW - 10 * HOUR);
  exec("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Beta', 'beta', ?)", OTHER_ORG, NOW - 9 * HOUR);
  for (const [id, name, email] of [
    ["u-owner", "Dev", "dev@example.com"],
    ["u-admin", "Ada", "ada@acme.com"],
    ["u-mia", "Mia", "mia@acme.com"],
    ["u-sam", "Sam", "sam@acme.com"],
    ["u-beta", "Bea", "bea@beta.com"],
  ]) {
    exec("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)", id!, name!, email!, NOW - 8 * HOUR, NOW - 8 * HOUR);
  }
  for (const [id, org, user, role] of [
    ["m-owner", ORG, "u-owner", "owner"],
    ["m-admin", ORG, "u-admin", "admin"],
    ["m-mia", ORG, "u-mia", "member"],
    ["m-sam", ORG, "u-sam", "member"],
    ["m-sam-beta", OTHER_ORG, "u-sam", "member"],
    ["m-beta", OTHER_ORG, "u-beta", "owner"],
  ]) {
    exec("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)", id!, org!, user!, role!, NOW - 7 * HOUR);
  }
  exec(
    `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, is_default)
VALUES ('app-crm', ?, 'crm', 'CRM', 'Contacts and deals', 'crm.example.com', 'every-acme-crm', 'service_binding', 'org', '{"id":"crm","providers":["openai"]}', 'active', 0)`,
    ORG,
  );
  exec(
    `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, is_default)
VALUES ('app-todo', ?, 'todo', 'Todo', 'Tasks', 'todo.example.com', 'every-acme-todo', 'service_binding', 'org', '{"id":"todo"}', 'active', 1)`,
    ORG,
  );
  exec(
    `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, is_default)
VALUES ('app-shared', ?, 'shared', 'Shared', 'Everyone has it', 'shared.example.com', 'every-acme-shared', 'service_binding', 'shared', '{"id":"shared"}', 'active', 0)`,
    ORG,
  );
  exec(
    `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, is_default)
VALUES ('app-gone', ?, 'gone', 'Gone', 'A tombstone', NULL, NULL, 'service_binding', 'org', '{"id":"gone"}', 'deleted', 0)`,
    ORG,
  );
  // Direct grants: the owner and Mia open crm; everyone has todo.
  for (const [id, user, app] of [
    ["ua-1", "u-owner", "app-crm"],
    ["ua-2", "u-mia", "app-crm"],
    ["ua-3", "u-owner", "app-todo"],
    ["ua-4", "u-admin", "app-todo"],
    ["ua-5", "u-mia", "app-todo"],
    ["ua-6", "u-sam", "app-todo"],
  ]) {
    exec("INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES (?, ?, ?, ?)", id!, user!, app!, ORG);
  }
  exec("INSERT INTO groups (id, organization_id, name, description, created_at, created_by) VALUES ('grp_sales', ?, 'Sales', 'The sales team', ?, 'u-owner')", ORG, NOW - 6 * HOUR);
  exec("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ('grp_sales', 'u-sam', ?)", ORG);
  exec("INSERT INTO group_app_access (group_id, app_row_id, organization_id) VALUES ('grp_sales', 'app-crm', ?)", ORG);
  exec("INSERT INTO sessions (id, expires_at, token, updated_at, user_id) VALUES ('sess-mia', ?, 'tok', ?, 'u-mia')", NOW + HOUR, NOW);
  exec(
    "INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, scopes, expires_at, created_at) VALUES ('pat-mia', 'u-mia', ?, 'app-crm', 'laptop', 'hash-mia', 'epat_ab12', '[\"*\"]', ?, ?)",
    ORG,
    NOW + 24 * HOUR,
    NOW - 2 * HOUR,
  );
  exec(
    "INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, scopes, expires_at, created_at) VALUES ('pat-ada', 'u-admin', ?, NULL, 'ci', 'hash-ada', 'epat_cd34', '[\"*\"]', ?, ?)",
    ORG,
    NOW + 24 * HOUR,
    NOW - HOUR,
  );
  exec(
    "INSERT INTO user_access_tokens (id, user_id, organization_id, app_row_id, name, token_hash, token_prefix, scopes, expires_at, created_at, revoked_at) VALUES ('pat-old', 'u-mia', ?, NULL, 'old', 'hash-old', 'epat_ef56', '[\"*\"]', ?, ?, ?)",
    ORG,
    NOW + 24 * HOUR,
    NOW - 3 * HOUR,
    NOW - 2 * HOUR,
  );
  exec(
    "INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, client_domain, redirect_uri, redirect_host, app_scope, access, created_at) VALUES ('mcpc_mia', 'u-mia', ?, 'claude', 'Claude', 'claude.ai', 'https://claude.ai/cb', 'claude.ai', 'selected', 'write', ?)",
    ORG,
    NOW - HOUR,
  );
  exec("INSERT INTO mcp_connection_apps (connection_id, app_row_id) VALUES ('mcpc_mia', 'app-crm')");
  exec(
    "INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, client_domain, redirect_uri, redirect_host, app_scope, access, created_at) VALUES ('mcpc_sam', 'u-sam', ?, 'cursor', 'Cursor', NULL, 'http://localhost:1/cb', 'localhost', 'all', 'read', ?)",
    ORG,
    NOW - 2 * HOUR,
  );
  exec("INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES ('inv-pat', ?, 'pat@acme.com', 'member', 'pending', ?, ?, 'u-owner')", ORG, NOW + HOUR, NOW - HOUR);
  exec("INSERT INTO invitation_link_tokens (id, invitation_id, token_hash) VALUES ('ilt-pat', 'inv-pat', ?)", sha256("einv_old"));
  exec("INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES ('inv-old', ?, 'old@acme.com', 'admin', 'pending', ?, ?, 'u-owner')", ORG, NOW - 1, NOW - 80 * HOUR);
  exec("INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES ('inv-done', ?, 'done@acme.com', 'member', 'accepted', ?, ?, 'u-owner')", ORG, NOW + HOUR, NOW - HOUR);
  // Usage: two days of OpenAI calls by Mia on crm, a DataForSEO call by the app itself on todo, and a Beta row that must not show.
  for (const [app, user, kind, target, day, calls, failures, input, output, cost] of [
    ["app-crm", "u-mia", "ai", "openai", "2026-10-03", 5, 1, 500, 100, 0],
    ["app-crm", "u-mia", "ai", "openai", "2026-10-04", 3, 0, 300, 60, 0],
    ["app-todo", "", "capability", "dataforseo", "2026-10-10", 2, 0, 0, 0, 1500],
    ["app-crm", "u-mia", "ai", "openai", "2026-09-30", 9, 0, 900, 90, 0],
  ]) {
    exec(
      "INSERT INTO usage_daily (organization_id, app_row_id, user_id, kind, target, day, calls, failures, input_tokens, output_tokens, cost_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ORG, app as string, user as string, kind as string, target as string, day as string, calls as number, failures as number, input as number, output as number, cost as number, NOW,
    );
  }
  exec("INSERT INTO usage_daily (organization_id, app_row_id, user_id, kind, target, day, calls, failures, input_tokens, output_tokens, cost_micros, updated_at) VALUES (?, 'app-crm', 'u-beta', 'ai', 'openai', '2026-10-05', 7, 0, 0, 0, 0, ?)", OTHER_ORG, NOW);
  exec("INSERT INTO org_app_settings (organization_id, app_row_id, monthly_call_cap, updated_at, updated_by) VALUES (?, 'app-todo', 500, ?, 'u-owner')", ORG, NOW);
  for (const [id, at, user, app, slug, tool, risk, decision, reason] of [
    ["call-1", NOW - 4 * HOUR, "u-mia", "app-crm", "crm", "list_contacts", "read", "allowed", null],
    ["call-2", NOW - 3 * HOUR, "u-mia", "app-crm", "crm", "delete_contact", "destructive", "blocked", "read_only"],
    ["call-3", NOW - 2 * HOUR, "u-sam", "app-todo", "todo", "add_todo", "write", "allowed", null],
    ["call-4", NOW - HOUR, "u-sam", null, null, "everyapp_whoami", "read", "allowed", null],
  ]) {
    exec(
      "INSERT INTO mcp_tool_calls (id, created_at, organization_id, user_id, credential_kind, credential_id, client_name, surface, app_row_id, app_slug, tool_name, risk, decision, reason, outcome, duration_ms) VALUES (?, ?, ?, ?, 'oauth', 'mcpc_x', 'Claude', ?, ?, ?, ?, ?, ?, ?, 'ok', 12)",
      id as string, at as number, ORG, user as string, app ? "app" : "gateway", app as string | null, slug as string | null, tool as string, risk as string, decision as string, reason as string | null,
    );
  }
}

describe("workspace show", () => {
  it("names the organization, its owners, the operator and the counts; email is configured by the setting names", async () => {
    await showWorkspace(opts());
    expect(data()).toMatchObject({
      organization: { id: ORG, name: "Acme", slug: "acme" },
      gateway: "https://example.com",
      owners: ["dev@example.com"],
      operator: { actor: "dev@example.com", email: "dev@example.com", userId: "u-owner" },
      email: { configured: false },
      counts: { members: 4, deactivated: 0, invitations: 1, groups: 1, apps: 3 },
    });
    expect(done()!["message"]).toBe("Acme: 4 members, 1 pending invitation, 1 group, 3 apps");

    gatewayWorker().secrets["EMAIL_FROM"] = "hi@example.com";
    gatewayWorker().secrets["RESEND_API_KEY"] = "re_x";
    events = [];
    await showWorkspace(opts());
    expect(data()["email"]).toEqual({ configured: true });
  });

  it("--org picks another organization by slug, name or id, and says which exist otherwise", async () => {
    for (const org of ["beta", "Beta", OTHER_ORG]) {
      events = [];
      await showWorkspace(opts({ org }));
      expect(data()).toMatchObject({ organization: { id: OTHER_ORG }, owners: ["bea@beta.com"], counts: { members: 2 } });
    }
    await expect(showWorkspace(opts({ org: "gamma" }))).rejects.toMatchObject({
      code: "ORGANIZATION_NOT_FOUND",
      message: expect.stringContaining("acme (Acme) and beta (Beta)"),
      data: { organizations: [{ slug: "acme" }, { slug: "beta" }] },
    });
  });

  it("--org by a name two organizations share is refused, never resolved to the older one; the slug and id still name each", async () => {
    // Names aren't unique, and any owner or admin can rename theirs: a newer organization named like Beta.
    sqlite().sqlite.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-beta-2', 'beta', 'beta-2', ?)").run(NOW - HOUR);
    await expect(showWorkspace(opts({ org: "Beta" }))).rejects.toMatchObject({
      code: "ORG_AMBIGUOUS",
      message: expect.stringContaining("2 organizations are named Beta: beta (org-beta) and beta-2 (org-beta-2)"),
      fix: "name it by its slug or id with --org",
      data: { organizations: [{ id: OTHER_ORG, slug: "beta" }, { id: "org-beta-2", slug: "beta-2" }] },
    });
    for (const [org, id] of [["beta", OTHER_ORG], ["beta-2", "org-beta-2"], ["org-beta-2", "org-beta-2"]]) {
      events = [];
      await showWorkspace(opts({ org }));
      expect(data()["organization"]["id"]).toBe(id);
    }
    // The install organization renamed to a name another organization has: its slug still names it.
    sqlite().sqlite.prepare("UPDATE organizations SET name = 'Beta' WHERE id = ?").run(ORG);
    events = [];
    await showWorkspace(opts({ org: "beta" }));
    expect(data()["organization"]["id"]).toBe(OTHER_ORG);
    await expect(showWorkspace(opts({ org: "beta" }))).resolves.toBeUndefined();
    await expect(showWorkspace(opts({ org: "BETA" }))).rejects.toMatchObject({ code: "ORG_AMBIGUOUS" });
  });
});

describe("workspace users", () => {
  it("lists the members by role and the pending invitations, expired ones marked", async () => {
    await listUsers(opts());
    expect(data()["members"].map((member: any) => [member.email, member.role, member.deactivated])).toEqual([
      ["dev@example.com", "owner", false],
      ["ada@acme.com", "admin", false],
      ["mia@acme.com", "member", false],
      ["sam@acme.com", "member", false],
    ]);
    expect(data()["invitations"]).toEqual([
      expect.objectContaining({ id: "inv-pat", email: "pat@acme.com", role: "member", expired: false }),
      expect.objectContaining({ id: "inv-old", email: "old@acme.com", role: "admin", expired: true }),
    ]);
    // "Pending" is what can still be accepted, the count `workspace show` gives; the expired row is said.
    expect(done()!["message"]).toBe("4 members and 1 pending invitation (1 expired) in Acme");
  });
});

describe("workspace invite", () => {
  /** The invitation an invite link's token opens, as findPendingInvitationByToken reads it. */
  const invitationByToken = (url: string) => {
    const token = new URL(url).searchParams.get("token")!;
    expect(token.startsWith("einv_")).toBe(true);
    return rows(
      "SELECT i.id, i.email, i.role, i.status, i.expires_at, i.inviter_id FROM invitation_link_tokens t JOIN invitations i ON i.id = t.invitation_id WHERE t.token_hash = ?",
      sha256(token),
    )[0];
  };

  it("writes a pending invitation in the operator's name and a link whose token hashes to the stored row", async () => {
    await inviteMember(opts(), "New.Person@Acme.com", "admin");
    const url = data()["url"] as string;
    expect(url.startsWith("https://example.com/accept-invitation?token=einv_")).toBe(true);
    expect(invitationByToken(url)).toMatchObject({
      email: "new.person@acme.com",
      role: "admin",
      status: "pending",
      inviter_id: "u-owner",
      expires_at: NOW + 72 * HOUR,
    });
    expect(data()).toMatchObject({
      invitation: { email: "new.person@acme.com", role: "admin", status: "pending", expired: false },
      emailed: false,
      next: [{ command: "pnpm everyapp workspace invite-link new.person@acme.com" }],
    });
    expect(done()!["message"]).toContain("The Gateway mailed nothing");
  });

  it("refuses a member, a live invitation, and an operator without an account", async () => {
    await expect(inviteMember(opts(), "mia@acme.com", "member")).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
    await expect(inviteMember(opts(), "pat@acme.com", "member")).rejects.toMatchObject({
      code: "ALREADY_INVITED",
      rerun: "pnpm everyapp workspace invite-link pat@acme.com",
    });
    // An expired invitation doesn't count: a new one is made.
    await inviteMember(opts(), "old@acme.com", "member");
    expect(rows("SELECT COUNT(*) AS n FROM invitations WHERE email = 'old@acme.com' AND status = 'pending'")[0]!["n"]).toBe(2);

    // The login's account isn't a member of the organization named: an invitation records its inviter.
    await expect(inviteMember(opts({ org: "beta" }), "another@beta.com", "member")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_A_MEMBER",
      message: expect.stringContaining("dev@example.com isn't a member of Beta"),
      fix: expect.stringContaining("get invited to Beta"),
    });
    expect(rows("SELECT COUNT(*) AS n FROM invitations WHERE email = 'another@beta.com'")[0]!["n"]).toBe(0);

    // The login's email has no account on this Gateway.
    sqlite().sqlite.prepare("UPDATE users SET email = 'someone@else.com' WHERE id = 'u-owner'").run();
    await expect(inviteMember(opts(), "another@acme.com", "member")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_A_MEMBER",
      message: expect.stringContaining("dev@example.com has no account on this Gateway"),
      fix: expect.stringContaining("pnpm everyapp setup"),
    });
    expect(rows("SELECT COUNT(*) AS n FROM invitations WHERE email = 'another@acme.com'")[0]!["n"]).toBe(0);
  });

  it("invite-link mints another token for a pending invitation; uninvite cancels it and every link", async () => {
    await newInviteLink(opts(), "pat@acme.com");
    const url = data()["url"] as string;
    expect(invitationByToken(url)).toMatchObject({ id: "inv-pat", status: "pending" });
    expect(rows("SELECT COUNT(*) AS n FROM invitation_link_tokens WHERE invitation_id = 'inv-pat'")[0]!["n"]).toBe(2);
    await expect(newInviteLink(opts(), "old@acme.com")).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING", message: expect.stringContaining("expired") });
    await expect(newInviteLink(opts(), "done@acme.com")).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });

    events = [];
    await cancelInvitation(opts(), "inv-pat");
    expect(data()["invitation"]).toMatchObject({ id: "inv-pat", status: "canceled" });
    expect(rows("SELECT status FROM invitations WHERE id = 'inv-pat'")[0]!["status"]).toBe("canceled");
    // What the Gateway's findPendingInvitationByToken would now refuse.
    expect(invitationByToken(url)).toMatchObject({ status: "canceled" });
    await expect(cancelInvitation(opts(), "pat@acme.com")).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });
});

describe("workspace deactivate and reactivate", () => {
  const live = () => ({
    banned: rows("SELECT banned, ban_reason, ban_expires FROM users WHERE id = 'u-mia'")[0],
    sessions: rows("SELECT id FROM sessions WHERE user_id = 'u-mia'").length,
    tokens: rows("SELECT id FROM user_access_tokens WHERE user_id = 'u-mia' AND revoked_at IS NULL").length,
    connections: rows("SELECT revoked_reason FROM mcp_connections WHERE user_id = 'u-mia'"),
  });

  it("bans the account (a row isUserBanned refuses), ends sessions, revokes tokens and connections, in one D1 batch; reactivate lifts the ban only", async () => {
    account.cf.calls.length = 0;
    await deactivateMember(opts(), "Mia@acme.com");
    expect(data()).toMatchObject({ member: { id: "u-mia", email: "mia@acme.com", deactivated: true }, already: false });
    // One request: a failed second one could never leave a banned user with live tokens.
    expect(writeBatches()).toEqual([
      ["UPDATE users", "DELETE FROM sessions", "UPDATE user_access_tokens", "UPDATE mcp_connections"],
    ]);
    expect(live()).toEqual({
      // banned with no expiry: isUserBanned(user) is true at any time.
      banned: { banned: 1, ban_reason: "Deactivated by dev@example.com (pnpm everyapp workspace deactivate)", ban_expires: null },
      sessions: 0,
      tokens: 0,
      connections: [{ revoked_reason: "user_deactivated" }],
    });
    // Nobody else was touched.
    expect(rows("SELECT id FROM user_access_tokens WHERE user_id = 'u-admin' AND revoked_at IS NULL")).toHaveLength(1);

    events = [];
    await deactivateMember(opts(), "u-mia");
    expect(data()["already"]).toBe(true);

    events = [];
    await reactivateMember(opts(), "mia@acme.com");
    expect(data()).toMatchObject({ member: { deactivated: false }, already: false });
    expect(live()).toMatchObject({ banned: { banned: 0, ban_reason: null }, tokens: 0, connections: [{ revoked_reason: "user_deactivated" }] });
    events = [];
    await reactivateMember(opts(), "mia@acme.com");
    expect(data()["already"]).toBe(true);
  });

  it("refuses the last owner, someone who isn't a member, and a member of another organization only", async () => {
    await expect(deactivateMember(opts(), "dev@example.com")).rejects.toMatchObject({
      code: "LAST_OWNER",
      rerun: "pnpm everyapp workspace role <email> owner",
    });
    await expect(deactivateMember(opts(), "nobody@acme.com")).rejects.toMatchObject({ code: "USER_NOT_FOUND", rerun: "pnpm everyapp workspace users" });
    await expect(deactivateMember(opts(), "bea@beta.com")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(rows("SELECT COUNT(*) AS n FROM users WHERE banned = 1")[0]!["n"]).toBe(0);
  });

  it("deactivates an owner once another owner can act: owners are peers, and the organization keeps one who isn't locked out", async () => {
    sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-admin'").run();
    await deactivateMember(opts(), "dev@example.com");
    expect(data()).toMatchObject({ member: { id: "u-owner", role: "owner", deactivated: true } });
    expect(rows("SELECT banned FROM users WHERE id = 'u-owner'")).toEqual([{ banned: 1 }]);
    // A deactivated owner doesn't count (the predicate `workspace role` holds, members.ts): Ada is
    // now the only owner who can act, so she stays, and the organization is never left locked out.
    await expect(deactivateMember(opts(), "ada@acme.com")).rejects.toMatchObject({
      code: "LAST_OWNER",
      message: expect.stringContaining("ada@acme.com is the last owner of Acme who can act, so they can't be deactivated"),
      rerun: "pnpm everyapp workspace role <email> owner",
      data: { organization: { id: ORG, slug: "acme" }, member: { id: "u-admin", email: "ada@acme.com" } },
    });
    expect(rows("SELECT banned FROM users WHERE id = 'u-admin'")).toEqual([{ banned: 0 }]);
    expect(rows("SELECT id FROM user_access_tokens WHERE id = 'pat-ada' AND revoked_at IS NULL")).toHaveLength(1);
    // Nor can she be removed.
    await expect(removeMember(opts({ yes: true }), "ada@acme.com")).rejects.toMatchObject({ code: "LAST_OWNER" });
    // A ban that has run out is no ban: dev counts again, so Ada may be deactivated after all.
    sqlite().sqlite.prepare("UPDATE users SET ban_expires = ? WHERE id = 'u-owner'").run(NOW - 1);
    events = [];
    await deactivateMember(opts(), "ada@acme.com");
    expect(data()["member"]).toMatchObject({ id: "u-admin", deactivated: true });
    // The deactivated owner can be removed while a live one remains; the live one is the last.
    await removeMember(opts({ yes: true }), "ada@acme.com");
    expect(rows("SELECT user_id FROM members WHERE organization_id = ? AND role = 'owner'", ORG)).toEqual([{ user_id: "u-owner" }]);
    await expect(removeMember(opts({ yes: true }), "dev@example.com")).rejects.toMatchObject({ code: "LAST_OWNER" });
  });

  it("is account-wide, so the sole live owner of another organization is refused through any organization they belong to", async () => {
    // Sam: a member of Acme, and Beta's only owner who can act (Bea demoted).
    sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-sam-beta'").run();
    sqlite().sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'm-beta'").run();
    await expect(deactivateMember(opts(), "sam@acme.com")).rejects.toMatchObject({
      code: "LAST_OWNER",
      message: expect.stringContaining(
        "sam@acme.com is the last owner of Beta who can act, and a deactivation is account-wide: it would leave Beta without one",
      ),
      // `workspace role` acts on the install organization; Beta's owner hands the role out in the Gateway.
      fix: "an owner of Beta makes someone else an owner under Manage workspace → Users, then run this again",
      data: { organization: { id: OTHER_ORG, name: "Beta", slug: "beta" }, member: { id: "u-sam" } },
    });
    expect(done()).toBeUndefined();
    expect(rows("SELECT banned FROM users WHERE id = 'u-sam'")).toEqual([{ banned: 0 }]);
    expect(rows("SELECT revoked_at FROM mcp_connections WHERE id = 'mcpc_sam'")).toEqual([{ revoked_at: null }]);
    // Through Beta itself, the same refusal names Beta as the organization acted on.
    await expect(deactivateMember(opts({ org: "beta" }), "sam@acme.com")).rejects.toMatchObject({
      code: "LAST_OWNER",
      message: expect.stringContaining("sam@acme.com is the last owner of Beta who can act, so they can't be deactivated"),
    });
    // Removing Sam from Acme is fine: the membership goes, the account stays (they own Beta).
    await removeMember(opts({ yes: true }), "sam@acme.com");
    expect(data()).toMatchObject({ accountDeleted: false, otherOrganizations: 1 });
    expect(rows("SELECT organization_id, role FROM members WHERE user_id = 'u-sam'")).toEqual([{ organization_id: OTHER_ORG, role: "owner" }]);
    // Once Beta has another owner who can act, Sam can be deactivated from Beta.
    sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-beta'").run();
    events = [];
    await deactivateMember(opts({ org: "beta" }), "sam@acme.com");
    expect(rows("SELECT banned FROM users WHERE id = 'u-sam'")).toEqual([{ banned: 1 }]);
  });

  it("holds the last-owner guard on the write itself: a member left as the only owner after the read is still refused", async () => {
    // The read sees a member; before the write, the owner is demoted and Mia made the only owner (the guard is SQL).
    const { deactivate } = await import("@/lib/gateway/workspace");
    const { openWorkspace } = await import("@/lib/gateway/workspace");
    const db = cfD1Database(account.cf, [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0]);
    const ws = await openWorkspace(db, { actor: "dev@example.com", email: "dev@example.com" }, { now: NOW });
    const racedBy = (change: () => void) => ({
      ...ws,
      db: {
        run: async (statements: Parameters<typeof db.run>[0]) => {
          if (statements.some((statement) => statement.sql.includes("UPDATE users SET banned = 1"))) change();
          return db.run(statements);
        },
      },
    });
    const raced = racedBy(() => {
      sqlite().sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'm-owner'").run();
      sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-mia'").run();
    });
    await expect(deactivate(raced, "mia@acme.com")).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(rows("SELECT banned FROM users WHERE id = 'u-mia'")[0]!["banned"]).toBe(0);
    expect(rows("SELECT id FROM sessions WHERE user_id = 'u-mia'")).toHaveLength(1);
    expect(rows("SELECT id FROM user_access_tokens WHERE id = 'pat-mia' AND revoked_at IS NULL")).toHaveLength(1);

    // The same across organizations: Sam made Beta's only live owner between the read and the write.
    const racedAcross = racedBy(() => {
      sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-sam-beta'").run();
      sqlite().sqlite.prepare("UPDATE members SET role = 'member' WHERE id = 'm-beta'").run();
    });
    await expect(deactivate(racedAcross, "sam@acme.com")).rejects.toMatchObject({
      code: "LAST_OWNER",
      data: { organization: { id: OTHER_ORG } },
    });
    expect(rows("SELECT banned FROM users WHERE id = 'u-sam'")[0]!["banned"]).toBe(0);
    expect(rows("SELECT revoked_at FROM mcp_connections WHERE id = 'mcpc_sam'")).toEqual([{ revoked_at: null }]);
  });
});

describe("workspace remove", () => {
  it("needs --yes unattended, then deletes the membership, grants, group places, tokens, connections and the account", async () => {
    await expect(removeMember({ ...opts(), interactive: false }, "mia@acme.com")).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      rerun: expect.stringContaining("--yes"),
      authorize: true,
      data: { userId: "u-mia", email: "mia@acme.com" },
    });
    expect(rows("SELECT id FROM members WHERE user_id = 'u-mia'")).toHaveLength(1);

    account.cf.calls.length = 0;
    await removeMember(opts({ yes: true }), "mia@acme.com");
    expect(data()).toMatchObject({
      member: { id: "u-mia", email: "mia@acme.com" },
      deactivatedInstead: false,
      accountDeleted: true,
      otherOrganizations: 0,
    });
    // One D1 batch: the grants, the group places, the tokens, the connections, the membership, the account.
    expect(writeBatches()).toEqual([
      ["DELETE FROM user_app_access", "DELETE FROM group_members", "UPDATE user_access_tokens", "UPDATE mcp_connections", "DELETE FROM members", "DELETE FROM users"],
    ]);
    expect(rows("SELECT id FROM members WHERE user_id = 'u-mia'")).toEqual([]);
    expect(rows("SELECT id FROM user_app_access WHERE user_id = 'u-mia'")).toEqual([]);
    expect(rows("SELECT id FROM users WHERE id = 'u-mia'")).toEqual([]);
    // Sam's rows, and the other organization's, are untouched.
    expect(rows("SELECT user_id FROM group_members WHERE group_id = 'grp_sales'")).toEqual([{ user_id: "u-sam" }]);
  });

  it("keeps the account of a member of another organization, and revokes only this organization's tokens and connections", async () => {
    await removeMember(opts({ yes: true }), "sam@acme.com");
    expect(data()).toMatchObject({ accountDeleted: false, otherOrganizations: 1 });
    expect(done()!["message"]).toContain("they belong to 1 other organization");
    expect(rows("SELECT organization_id FROM members WHERE user_id = 'u-sam'")).toEqual([{ organization_id: OTHER_ORG }]);
    expect(rows("SELECT id FROM users WHERE id = 'u-sam'")).toHaveLength(1);
    expect(rows("SELECT user_id FROM group_members WHERE group_id = 'grp_sales'")).toEqual([]);
    expect(rows("SELECT revoked_reason FROM mcp_connections WHERE id = 'mcpc_sam'")).toEqual([{ revoked_reason: "member_removed" }]);
    // Mia's connection to this organization stays.
    expect(rows("SELECT revoked_at FROM mcp_connections WHERE id = 'mcpc_mia'")).toEqual([{ revoked_at: null }]);
  });

  it("removes an owner once another owner exists, never the last one", async () => {
    await expect(removeMember(opts({ yes: true }), "dev@example.com")).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(rows("SELECT id FROM members WHERE user_id = 'u-owner'")).toHaveLength(1);
    sqlite().sqlite.prepare("UPDATE members SET role = 'owner' WHERE id = 'm-admin'").run();
    events = [];
    await removeMember(opts({ yes: true }), "dev@example.com");
    expect(data()).toMatchObject({ member: { id: "u-owner" }, accountDeleted: true });
    expect(rows("SELECT id FROM members WHERE user_id = 'u-owner'")).toEqual([]);
    expect(rows("SELECT user_id FROM members WHERE organization_id = ? AND role = 'owner'", ORG)).toEqual([{ user_id: "u-admin" }]);
  });

  it("keeps the account on a hosted Gateway, and deactivates instead where Access could let them back in", async () => {

    sqlite().sqlite.prepare("UPDATE _everyapp_install SET deployment_mode = 'hosted'").run();
    await removeMember(opts({ yes: true }), "mia@acme.com");
    expect(data()).toMatchObject({ accountDeleted: false, otherOrganizations: 0 });
    expect(rows("SELECT id FROM users WHERE id = 'u-mia'")).toHaveLength(1);
    expect(rows("SELECT id FROM members WHERE user_id = 'u-mia'")).toEqual([]);
    sqlite().sqlite.prepare("UPDATE _everyapp_install SET deployment_mode = 'self-hosted'").run();

    gatewayWorker().secrets["CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS"] = "acme.com";
    events = [];
    await removeMember(opts({ yes: true }), "ada@acme.com");
    expect(data()).toMatchObject({ member: { id: "u-admin", deactivated: true }, deactivatedInstead: true, accountDeleted: false });
    expect(rows("SELECT banned FROM users WHERE id = 'u-admin'")).toEqual([{ banned: 1 }]);
    expect(rows("SELECT id FROM members WHERE user_id = 'u-admin'")).toHaveLength(1);
    expect(rows("SELECT id FROM user_access_tokens WHERE id = 'pat-ada' AND revoked_at IS NULL")).toEqual([]);
    expect(done()!["message"]).toContain("Deactivated ada@acme.com instead");
  });
});

describe("workspace reset-link", () => {
  it("writes Better Auth's reset token for one hour and prints the link; a deactivated account is refused", async () => {
    await passwordResetLink(opts(), "mia@acme.com");
    const url = data()["url"] as string;
    const token = new URL(url).searchParams.get("token")!;
    expect(url.startsWith("https://example.com/reset-password?token=")).toBe(true);
    expect(rows("SELECT value, expires_at FROM verifications WHERE identifier = ?", `reset-password:${token}`)).toEqual([
      { value: "u-mia", expires_at: NOW + HOUR },
    ]);
    expect(data()["expiresAt"]).toBe(new Date(NOW + HOUR).toISOString());

    await deactivateMember(opts(), "mia@acme.com");
    await expect(passwordResetLink(opts(), "mia@acme.com")).rejects.toMatchObject({
      code: "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      rerun: "pnpm everyapp workspace reactivate mia@acme.com",
    });
  });

  it("refuses a member of another organization too: a password is account-wide, the Gateway's own rule", async () => {
    await expect(passwordResetLink(opts(), "sam@acme.com")).rejects.toMatchObject({
      code: "USER_IN_OTHER_ORGANIZATION",
      message: expect.stringContaining("sam@acme.com also belongs to Beta, and a password is account-wide"),
      fix: expect.stringContaining("Forgot password"),
      data: { member: { id: "u-sam" }, organizations: [{ id: OTHER_ORG, name: "Beta", slug: "beta" }] },
    });
    expect(rows("SELECT COUNT(*) AS n FROM verifications WHERE value = 'u-sam'")[0]!["n"]).toBe(0);
    // Through Beta the same: the other organization is then Acme.
    await expect(passwordResetLink(opts({ org: "beta" }), "sam@acme.com")).rejects.toMatchObject({
      code: "USER_IN_OTHER_ORGANIZATION",
      data: { organizations: [{ id: ORG, name: "Acme" }] },
    });
  });
});

describe("workspace groups", () => {
  it("lists the groups with counts; create refuses a taken name (letter case aside) and a bad one", async () => {
    await listGroups(opts());
    expect(data()["groups"]).toEqual([expect.objectContaining({ id: "grp_sales", name: "Sales", members: 1, apps: 1 })]);

    events = [];
    await createGroup(opts({ description: "  Ops  " }), " Ops ");
    const created = data()["group"];
    expect(created).toMatchObject({ name: "Ops", description: "Ops", members: 0, apps: 0 });
    expect(created.id).toMatch(/^grp_[0-9a-f]{16}$/);
    expect(rows("SELECT name, created_by FROM groups WHERE id = ?", created.id)).toEqual([{ name: "Ops", created_by: "u-owner" }]);

    await expect(createGroup(opts(), "sales")).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
    await expect(createGroup(opts(), "x".repeat(61))).rejects.toMatchObject({ code: "GROUP_NAME_INVALID" });
    await expect(createGroup(opts(), "  ")).rejects.toMatchObject({ code: "GROUP_NAME_INVALID" });
  });

  it("set renames and describes; delete needs --yes and takes the members and apps with it", async () => {
    await expect(updateGroup(opts(), "Sales")).rejects.toMatchObject({ code: "NOTHING_TO_SET" });
    await updateGroup(opts({ name: "Sales team", description: "" }), "grp_sales");
    expect(rows("SELECT name, description FROM groups WHERE id = 'grp_sales'")).toEqual([{ name: "Sales team", description: null }]);
    await createGroup(opts(), "Ops");
    await expect(updateGroup(opts({ name: "ops" }), "Sales team")).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
    await expect(updateGroup(opts({ name: "x" }), "grp_nope")).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });

    await expect(deleteGroup({ ...opts(), interactive: false }, "Sales team")).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    events = [];
    await deleteGroup(opts({ yes: true }), "Sales team");
    expect(data()["group"]).toMatchObject({ id: "grp_sales", members: 1, apps: 1 });
    expect(rows("SELECT id FROM groups WHERE id = 'grp_sales'")).toEqual([]);
    expect(rows("SELECT user_id FROM group_members WHERE group_id = 'grp_sales'")).toEqual([]);
    expect(rows("SELECT app_row_id FROM group_app_access WHERE group_id = 'grp_sales'")).toEqual([]);
    // Sam's direct grants stay.
    expect(rows("SELECT app_row_id FROM user_app_access WHERE user_id = 'u-sam'")).toEqual([{ app_row_id: "app-todo" }]);
  });

  it("members: lists who is in it; --add, --remove and --set change it, members of the organization only", async () => {
    await groupMembersCommand(opts(), "Sales");
    expect(data()["members"].map((member: any) => [member.email, member.inGroup])).toEqual([
      ["ada@acme.com", false],
      ["dev@example.com", false],
      ["mia@acme.com", false],
      ["sam@acme.com", true],
    ]);

    events = [];
    await groupMembersCommand(opts({ add: ["mia@acme.com", "u-admin", "sam@acme.com"], remove: ["dev@example.com"] }), "Sales");
    expect(data()).toMatchObject({ added: [{ id: "u-mia" }, { id: "u-admin" }], removed: [] });
    expect(rows("SELECT user_id, added_by FROM group_members WHERE group_id = 'grp_sales' ORDER BY user_id")).toEqual([
      { user_id: "u-admin", added_by: "u-owner" },
      { user_id: "u-mia", added_by: "u-owner" },
      { user_id: "u-sam", added_by: null },
    ]);

    events = [];
    await groupMembersCommand(opts({ set: ["mia@acme.com"] }), "Sales");
    expect(data()).toMatchObject({ added: [], removed: [{ id: "u-admin" }, { id: "u-sam" }], group: { members: 1 } });
    expect(rows("SELECT user_id FROM group_members WHERE group_id = 'grp_sales'")).toEqual([{ user_id: "u-mia" }]);

    await expect(groupMembersCommand(opts({ add: ["bea@beta.com"] }), "Sales")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    await expect(groupMembersCommand(opts({ set: ["mia@acme.com"], add: ["sam@acme.com"] }), "Sales")).rejects.toMatchObject({ code: "FLAGS_CONFLICT" });
  });

  it("apps: lists what it opens; --add, --remove and --set change it, the organization's own apps only", async () => {
    await groupAppsCommand(opts(), "Sales");
    expect(data()["apps"].map((app: any) => [app.appId, app.granted])).toEqual([
      ["crm", true],
      ["todo", false],
    ]);
    events = [];
    await groupAppsCommand(opts({ set: ["todo"] }), "grp_sales");
    expect(data()).toMatchObject({ added: [{ appId: "todo" }], removed: [{ appId: "crm" }], group: { apps: 1 } });
    expect(rows("SELECT app_row_id, granted_by FROM group_app_access WHERE group_id = 'grp_sales'")).toEqual([{ app_row_id: "app-todo", granted_by: "u-owner" }]);
    events = [];
    await groupAppsCommand(opts({ remove: ["todo"], add: ["app-crm"] }), "Sales");
    expect(rows("SELECT app_row_id FROM group_app_access WHERE group_id = 'grp_sales'")).toEqual([{ app_row_id: "app-crm" }]);
    await expect(groupAppsCommand(opts({ add: ["shared"] }), "Sales")).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });
    await expect(groupAppsCommand(opts({ add: ["gone"] }), "Sales")).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

describe("workspace apps", () => {
  it("lists every app with who can open it and what it needs set (the Gateway's setting names)", async () => {
    await listApps(opts());
    expect(data()["apps"].map((app: any) => [app.appId, app.everyone, app.accessCount, app.scope])).toEqual([
      ["crm", false, 3, "org"],
      ["shared", false, 0, "shared"],
      ["todo", true, 4, "org"],
    ]);
    // crm lists openai: OPENAI_API_KEY isn't on the Gateway yet, and `configure crm` is what asks for it.
    const crm = data()["apps"].find((app: any) => app.appId === "crm");
    expect(crm.setup).toMatchObject({ ready: false, unmet: [{ names: ["OPENAI_API_KEY"] }], command: { command: "pnpm everyapp configure crm" } });
    expect(data()["next"]).toEqual([{ command: "pnpm everyapp configure crm", note: "crm" }]);
    expect(data()["apps"].find((app: any) => app.appId === "todo").setup).toBeNull();

    gatewayWorker().secrets["OPENAI_API_KEY"] = "sk";
    events = [];
    await listApps(opts());
    expect(data()["apps"].find((app: any) => app.appId === "crm").setup).toMatchObject({ ready: true });
    expect(data()["next"]).toBeUndefined();
  });

  it("set changes the name and description, and --everyone on grants every member now", async () => {
    await expect(updateApp(opts(), "crm")).rejects.toMatchObject({ code: "NOTHING_TO_SET" });
    // A blank name is refused, never silently kept (the parser refuses it first on the command line).
    await expect(updateApp(opts({ name: "   " }), "crm")).rejects.toMatchObject({
      code: "APP_NAME_INVALID",
      message: "An app's name is 1 to 255 characters, not empty",
    });
    await expect(updateApp(opts({ name: "x".repeat(256) }), "crm")).rejects.toMatchObject({ code: "APP_NAME_INVALID" });
    expect(rows("SELECT name FROM apps WHERE id = 'app-crm'")).toEqual([{ name: "CRM" }]);
    expect(() => lib.appName("  ")).toThrow("not empty");
    await updateApp(opts({ name: "Open CRM", description: "Deals", everyone: "on" }), "crm");
    expect(data()).toMatchObject({ app: { appId: "crm", name: "Open CRM", description: "Deals", everyone: true, accessCount: 4 }, granted: 2 });
    expect(rows("SELECT name, description, is_default FROM apps WHERE id = 'app-crm'")).toEqual([{ name: "Open CRM", description: "Deals", is_default: 1 }]);
    expect(rows("SELECT user_id, granted_by FROM user_app_access WHERE app_row_id = 'app-crm' ORDER BY user_id")).toEqual([
      { user_id: "u-admin", granted_by: "u-owner" },
      { user_id: "u-mia", granted_by: null },
      { user_id: "u-owner", granted_by: null },
      { user_id: "u-sam", granted_by: "u-owner" },
    ]);
    // Off keeps the grants.
    events = [];
    await updateApp(opts({ everyone: "off" }), "app-crm");
    expect(data()["app"]).toMatchObject({ everyone: false, accessCount: 4 });
    await expect(updateApp(opts({ everyone: "on" }), "shared")).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });
    await expect(updateApp(opts({ name: "x" }), "gone")).rejects.toMatchObject({ code: "APP_NOT_FOUND", rerun: "pnpm everyapp workspace apps" });
  });

  it("access lists direct grants and groups; --add, --remove and --set change the direct grants only", async () => {
    await appAccessCommand(opts(), "crm");
    expect(data()["users"].map((user: any) => [user.email, user.direct, user.viaGroups])).toEqual([
      ["ada@acme.com", false, []],
      ["dev@example.com", true, []],
      ["mia@acme.com", true, []],
      ["sam@acme.com", false, ["Sales"]],
    ]);
    expect(done()!["message"]).toBe("3 members of 4 can open crm.");

    events = [];
    await appAccessCommand(opts({ set: ["ada@acme.com", "sam@acme.com"] }), "crm");
    expect(data()).toMatchObject({ granted: [{ id: "u-admin" }, { id: "u-sam" }], revoked: [{ id: "u-owner" }, { id: "u-mia" }] });
    expect(rows("SELECT user_id FROM user_app_access WHERE app_row_id = 'app-crm' ORDER BY user_id")).toEqual([{ user_id: "u-admin" }, { user_id: "u-sam" }]);
    // The group grant is still there.
    expect(rows("SELECT group_id FROM group_app_access WHERE app_row_id = 'app-crm'")).toEqual([{ group_id: "grp_sales" }]);

    events = [];
    await appAccessCommand(opts({ add: ["mia@acme.com"], remove: ["ada@acme.com"] }), "crm");
    expect(data()).toMatchObject({ granted: [{ id: "u-mia" }], revoked: [{ id: "u-admin" }] });
    expect(rows("SELECT user_id FROM user_app_access WHERE app_row_id = 'app-crm' ORDER BY user_id")).toEqual([{ user_id: "u-mia" }, { user_id: "u-sam" }]);
    await expect(appAccessCommand(opts({ remove: ["bea@beta.com"] }), "crm")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    await expect(appAccessCommand(opts(), "shared")).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });
  });

  it("cap sets, changes and lifts the monthly cap, on the organization's own apps and shared ones", async () => {
    await setCap(opts(), "crm", 5000);
    expect(data()).toMatchObject({ app: { appId: "crm" }, cap: 5000, was: null });
    expect(rows("SELECT monthly_call_cap, updated_by FROM org_app_settings WHERE app_row_id = 'app-crm'")).toEqual([{ monthly_call_cap: 5000, updated_by: "u-owner" }]);
    events = [];
    await setCap(opts(), "todo", 250);
    expect(data()).toMatchObject({ cap: 250, was: 500 });
    events = [];
    await setCap(opts(), "todo", null);
    expect(data()).toMatchObject({ cap: null, was: 250 });
    expect(rows("SELECT app_row_id FROM org_app_settings WHERE app_row_id = 'app-todo'")).toEqual([]);
    events = [];
    await setCap(opts(), "shared", 10);
    expect(rows("SELECT organization_id FROM org_app_settings WHERE app_row_id = 'app-shared'")).toEqual([{ organization_id: ORG }]);
    await expect(setCap(opts(), "crm", 0)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(setCap(opts(), "crm", 1.5)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(setCap(opts(), "gone", 10)).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

describe("workspace app cap and the event bus", () => {
  const capAlerts = () =>
    rows("SELECT id, name, sink, url, secret, recipients, events, enabled, builtin, description, created_at, updated_at, created_by FROM event_subscriptions WHERE organization_id = ? AND builtin = 'cap_alerts'", ORG);
  // By app: the tests' clock is fixed, and ids made in one millisecond don't sort.
  const capEvents = () =>
    rows("SELECT organization_id, type, version, actor, data, app_row_id FROM events WHERE type = 'cap.raised' ORDER BY app_row_id").map((row) => ({
      ...row,
      actor: JSON.parse(String(row["actor"])),
      data: JSON.parse(String(row["data"])),
    }));
  const CRM = { id: "crm", rowId: "app-crm", name: "CRM" };

  it("the organization's first cap makes the built-in Cap alerts subscription and queues cap.raised, in the cap's batch", async () => {
    // A webhook on cap.raised gets a delivery; the cap alerts row (cap.warning, cap.reached) doesn't.
    sqlite().sqlite.prepare(
      `INSERT INTO event_subscriptions (id, organization_id, name, sink, url, events, enabled, created_at, updated_at)
VALUES ('sub_hook', ?, 'Ops', 'webhook', 'https://hooks.example.com/x', '["cap.raised"]', 1, 0, 0)`,
    ).run(ORG);
    account.cf.calls.length = 0;
    await setCap(opts(), "crm", 5000);
    const [row] = capAlerts();
    expect(capAlerts()).toHaveLength(1);
    expect(row).toEqual({
      id: expect.stringMatching(/^sub_[0-9a-f]{24}$/),
      name: "Cap alerts",
      sink: "email",
      url: null,
      secret: null,
      recipients: "admins",
      events: JSON.stringify(["cap.warning", "cap.reached"]),
      enabled: 1,
      builtin: "cap_alerts",
      description: "Owners and admins get an email at 80% and at the cap.",
      created_at: NOW,
      updated_at: NOW,
      created_by: "operator:dev@example.com",
    });
    expect(capEvents()).toEqual([
      {
        organization_id: ORG,
        type: "cap.raised",
        version: 1,
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { app: CRM, cap: 5000, previousCap: null, source: "app" },
        app_row_id: "app-crm",
      },
    ]);
    expect(rows("SELECT subscription_id, status FROM event_deliveries")).toEqual([{ subscription_id: "sub_hook", status: "pending" }]);
    expect(writeBatches()).toEqual([["INSERT INTO org_app_settings", "INSERT INTO event_subscriptions", "INSERT INTO events", "INSERT INTO event_deliveries"]]);
    expect(data()["capAlerts"]).toEqual({ subscriptionId: row!["id"], message: expect.stringContaining("events list shows it") });
    expect(done()!["message"]).toContain("Owners and admins are emailed at 80% and at the cap");

    // A second cap, on another app: no second row, and the output says nothing of it.
    events = [];
    await setCap(opts(), "todo", 1000);
    expect(capAlerts()).toHaveLength(1);
    expect(data()["capAlerts"]).toBeNull();
    expect(done()!["message"]).not.toContain("emailed");
    expect(capEvents().map((event) => event.data)).toEqual([
      { app: CRM, cap: 5000, previousCap: null, source: "app" },
      { app: { id: "todo", rowId: "app-todo", name: "Todo" }, cap: 1000, previousCap: 500, source: "app" },
    ]);
  });

  it("a lowered cap is not an event; a removed one is cap.raised with cap null, and makes no subscription", async () => {
    await setCap(opts(), "todo", 100);
    expect(capEvents()).toEqual([]);
    expect(rows("SELECT monthly_call_cap FROM org_app_settings WHERE app_row_id = 'app-todo'")).toEqual([{ monthly_call_cap: 100 }]);
    // The number set still makes the subscription, as the Gateway's does.
    expect(capAlerts()).toHaveLength(1);
    sqlite().sqlite.exec("DELETE FROM event_subscriptions");

    events = [];
    await setCap(opts(), "todo", null);
    expect(capEvents().map((event) => event.data)).toEqual([
      { app: { id: "todo", rowId: "app-todo", name: "Todo" }, cap: null, previousCap: 100, source: "app" },
    ]);
    expect(capAlerts()).toEqual([]);
    expect(data()["capAlerts"]).toBeNull();

    // Removing a cap that isn't there: nothing changed, nothing to announce.
    events = [];
    await setCap(opts(), "crm", null);
    expect(capEvents()).toHaveLength(1);
  });

  it("leaves a disabled built-in row alone: a person turned it off", async () => {
    sqlite().sqlite.prepare(
      `INSERT INTO event_subscriptions (id, organization_id, name, sink, recipients, events, enabled, builtin, created_at, updated_at)
VALUES ('sub_off', ?, 'Cap alerts', 'email', 'admins', '["cap.warning","cap.reached"]', 0, 'cap_alerts', 0, 0)`,
    ).run(ORG);
    await setCap(opts(), "crm", 5000);
    expect(rows("SELECT id, enabled FROM event_subscriptions WHERE organization_id = ?", ORG)).toEqual([{ id: "sub_off", enabled: 0 }]);
    expect(data()["capAlerts"]).toBeNull();
    // Another organization's cap alerts are its own.
    events = [];
    await setCap(opts({ org: "beta" }), "shared", 10);
    expect(rows("SELECT organization_id FROM event_subscriptions WHERE builtin = 'cap_alerts' ORDER BY organization_id")).toEqual([
      { organization_id: ORG },
      { organization_id: OTHER_ORG },
    ]);
  });

  it("on a Gateway from before the event tables, writes the cap only", async () => {
    sqlite().sqlite.exec("DROP TABLE event_deliveries; DROP TABLE events; DROP TABLE event_subscriptions");
    account.cf.calls.length = 0;
    await setCap(opts(), "crm", 5000);
    expect(rows("SELECT monthly_call_cap FROM org_app_settings WHERE app_row_id = 'app-crm'")).toEqual([{ monthly_call_cap: 5000 }]);
    expect(writeBatches()).toEqual([["INSERT INTO org_app_settings"]]);
    expect(data()).toMatchObject({ cap: 5000, was: null, capAlerts: null });
  });
});

describe("workspace usage", () => {
  it("sums the month per app (every callable app, with its cap), per member and per provider", async () => {
    await reportUsage(opts({ month: "2026-10" }));
    expect(data()["byApp"]).toEqual([
      // Only allowed tool calls count (call-2 was blocked), as the Gateway's summary counts them.
      expect.objectContaining({ appSlug: "crm", calls: 8, failures: 1, inputTokens: 800, outputTokens: 160, toolCalls: 1, monthlyCallCap: null, callable: true }),
      expect.objectContaining({ appSlug: "todo", calls: 2, costMicros: 1500, toolCalls: 1, monthlyCallCap: 500, callable: true }),
      expect.objectContaining({ appSlug: "shared", calls: 0, toolCalls: 0, callable: true }),
    ]);
    expect(data()["byMember"]).toEqual([
      expect.objectContaining({ userId: "u-mia", email: "mia@acme.com", calls: 8, toolCalls: 1 }),
      expect.objectContaining({ userId: "", email: null, calls: 2 }),
      // Sam's gateway-surface call (no app) counts for them, not for an app.
      expect.objectContaining({ userId: "u-sam", calls: 0, toolCalls: 2 }),
    ]);
    expect(data()["byTarget"]).toEqual([
      expect.objectContaining({ kind: "ai", target: "openai", calls: 8 }),
      expect.objectContaining({ kind: "capability", target: "dataforseo", calls: 2, costMicros: 1500 }),
    ]);
    expect(done()!["message"]).toBe("Acme, 2026-10: 10 provider calls and 2 tool calls across 3 apps");

    // The current month by default; September has the older row only.
    events = [];
    await reportUsage(opts({ month: "2026-09" }));
    expect(data()["byApp"].find((row: any) => row.appSlug === "crm")).toMatchObject({ calls: 9, toolCalls: 0 });
    events = [];
    await reportUsage(opts());
    expect(data()["month"]).toBe("2026-10");
    await expect(reportUsage(opts({ month: "2026-13" }))).rejects.toMatchObject({ code: "INVALID_MONTH" });
  });
});

describe("workspace activity", () => {
  it("lists the trail newest first with the Activity page's filters, one page at a time", async () => {
    await listActivity(opts());
    expect(data()["calls"].map((call: any) => [call.id, call.user.email, call.app.slug, call.tool.name, call.decision])).toEqual([
      ["call-4", "sam@acme.com", null, "everyapp_whoami", "allowed"],
      ["call-3", "sam@acme.com", "todo", "add_todo", "allowed"],
      ["call-2", "mia@acme.com", "crm", "delete_contact", "blocked"],
      ["call-1", "mia@acme.com", "crm", "list_contacts", "allowed"],
    ]);
    expect(data()["nextBefore"]).toBeNull();
    expect(data()["calls"][2]).toMatchObject({ reason: "read_only", tool: { risk: "destructive" }, credential: { kind: "oauth", clientName: "Claude" }, createdAt: new Date(NOW - 3 * HOUR).toISOString() });

    events = [];
    await listActivity(opts({ app: "crm", decision: "blocked" }));
    expect(data()["calls"].map((call: any) => call.id)).toEqual(["call-2"]);
    events = [];
    await listActivity(opts({ user: "sam@acme.com", risk: "write" }));
    expect(data()["calls"].map((call: any) => call.id)).toEqual(["call-3"]);
    events = [];
    await listActivity(opts({ since: NOW - 2 * HOUR }));
    expect(data()["calls"].map((call: any) => call.id)).toEqual(["call-4", "call-3"]);

    events = [];
    await listActivity(opts({ limit: 3 }));
    expect(data()["calls"].map((call: any) => call.id)).toEqual(["call-4", "call-3", "call-2"]);
    const cursor = data()["nextBefore"] as string;
    expect(cursor).toBe(`${NOW - 3 * HOUR}:call-2`);
    expect(data()["next"]).toEqual([{ command: `pnpm everyapp workspace activity --before ${cursor}`, note: "the next page" }]);
    events = [];
    const [createdAt, id] = cursor.split(":");
    await listActivity(opts({ limit: 3, before: { createdAt: Number(createdAt), id: id! } }));
    expect(data()["calls"].map((call: any) => call.id)).toEqual(["call-1"]);
    expect(data()["nextBefore"]).toBeNull();
    await expect(listActivity(opts({ app: "gone" }))).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("--user takes the id of someone who has left, whose calls the trail still lists by id; an unknown email is refused", async () => {
    await removeMember(opts({ yes: true }), "mia@acme.com");
    events = [];
    await listActivity(opts({ user: "u-mia" }));
    expect(data()["calls"].map((call: any) => [call.id, call.user])).toEqual([
      ["call-2", { id: "u-mia", name: null, email: null }],
      ["call-1", { id: "u-mia", name: null, email: null }],
    ]);
    expect(done()!["message"]).toBe("2 tool calls in Acme");
    await expect(listActivity(opts({ user: "mia@acme.com" }))).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    await expect(listActivity(opts({ user: "nobody@acme.com" }))).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    // The same on the other two trails: nothing of theirs is left, and the headline says who was asked for.
    events = [];
    await listTokens(opts({ user: "u-mia", all: true }));
    expect(done()!["message"]).toBe("0 personal access tokens of u-mia (no longer a member) in Acme");
    events = [];
    await listConnections(opts({ user: "u-mia" }));
    expect(done()!["message"]).toBe("0 AI connections of u-mia (no longer a member) in Acme");
  });
});

describe("workspace tokens and connections", () => {
  it("lists every member's active tokens (never a hash), one member's, and all of them; revoke works once", async () => {
    await listTokens(opts());
    expect(data()["tokens"]).toEqual([
      expect.objectContaining({ id: "pat-ada", user: { id: "u-admin", email: "ada@acme.com" }, name: "ci", prefix: "epat_cd34", app: null, scopes: ["*"], active: true }),
      expect.objectContaining({ id: "pat-mia", user: { id: "u-mia", email: "mia@acme.com" }, name: "laptop", prefix: "epat_ab12", app: "crm", active: true }),
    ]);
    expect(JSON.stringify(data())).not.toContain("hash-");
    events = [];
    await listTokens(opts({ user: "mia@acme.com", all: true }));
    expect(data()["tokens"].map((token: any) => [token.id, token.active])).toEqual([
      ["pat-mia", true],
      ["pat-old", false],
    ]);

    events = [];
    await revokeToken(opts(), "pat-mia");
    expect(data()).toMatchObject({ token: { id: "pat-mia", active: false, revokedAt: new Date(NOW).toISOString() }, already: false });
    expect(rows("SELECT revoked_at FROM user_access_tokens WHERE id = 'pat-mia'")).toEqual([{ revoked_at: NOW }]);
    events = [];
    await revokeToken(opts(), "pat-mia");
    expect(data()["already"]).toBe(true);
    await expect(revokeToken(opts(), "pat-nope")).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND", rerun: "pnpm everyapp workspace tokens" });
  });

  it("lists every member's AI connections with their apps and access; revoke shuts the client out", async () => {
    await listConnections(opts());
    expect(data()["connections"]).toEqual([
      expect.objectContaining({ id: "mcpc_mia", user: { id: "u-mia", email: "mia@acme.com" }, clientName: "Claude", clientDomain: "claude.ai", apps: ["crm"], access: "write" }),
      expect.objectContaining({ id: "mcpc_sam", clientName: "Cursor", apps: "all", access: "read" }),
    ]);
    events = [];
    await listConnections(opts({ user: "u-sam" }));
    expect(data()["connections"].map((connection: any) => connection.id)).toEqual(["mcpc_sam"]);

    events = [];
    await revokeConnection(opts(), "mcpc_mia");
    expect(data()).toMatchObject({ connection: { id: "mcpc_mia", revokedReason: "user" }, already: false });
    expect(rows("SELECT revoked_at, revoked_by, revoked_reason FROM mcp_connections WHERE id = 'mcpc_mia'")).toEqual([
      { revoked_at: NOW, revoked_by: "u-owner", revoked_reason: "user" },
    ]);
    events = [];
    await revokeConnection(opts(), "mcpc_mia");
    expect(data()["already"]).toBe(true);
    events = [];
    await listConnections(opts());
    expect(data()["connections"].map((connection: any) => connection.id)).toEqual(["mcpc_sam"]);
    await expect(revokeConnection(opts(), "mcpc_nope")).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });
});

describe("an API-token operator", () => {
  it("can't invite (an invitation records its inviter), and writes NULL into every *_by column", async () => {
    const ws = await lib.openWorkspace(gatewayD1(), { actor: `api-token:${ACCOUNT_ID}`, email: null }, { now: NOW });
    expect(ws.operator).toEqual({ actor: `api-token:${ACCOUNT_ID}`, email: null, userId: null });
    await expect(lib.invite(ws, "new@acme.com", "member")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_A_MEMBER",
      message: expect.stringContaining("An API token has no account on the Gateway"),
      fix: expect.stringContaining("pnpm everyapp login"),
    });
    expect(rows("SELECT COUNT(*) AS n FROM invitations WHERE email = 'new@acme.com'")[0]!["n"]).toBe(0);

    const group = await lib.createGroup(ws, { name: "Ops" });
    expect(rows("SELECT created_by FROM groups WHERE id = ?", group.id)).toEqual([{ created_by: null }]);
    await lib.setGroupMembers(ws, group, { add: ["mia@acme.com"] });
    expect(rows("SELECT added_by FROM group_members WHERE group_id = ?", group.id)).toEqual([{ added_by: null }]);
    await lib.setGroupApps(ws, group, { add: ["crm"] });
    expect(rows("SELECT granted_by FROM group_app_access WHERE group_id = ?", group.id)).toEqual([{ granted_by: null }]);
    await lib.setAppAccess(ws, await lib.findApp(ws, "crm"), { add: ["ada@acme.com"] });
    expect(rows("SELECT granted_by FROM user_app_access WHERE app_row_id = 'app-crm' AND user_id = 'u-admin'")).toEqual([{ granted_by: null }]);
    await lib.updateApp(ws, "crm", { everyone: true });
    expect(rows("SELECT granted_by FROM user_app_access WHERE app_row_id = 'app-crm' AND user_id = 'u-sam'")).toEqual([{ granted_by: null }]);
    await lib.setMonthlyCap(ws, "crm", 10);
    expect(rows("SELECT updated_by FROM org_app_settings WHERE app_row_id = 'app-crm'")).toEqual([{ updated_by: null }]);
    await lib.revokeConnection(ws, "mcpc_mia");
    expect(rows("SELECT revoked_by, revoked_reason FROM mcp_connections WHERE id = 'mcpc_mia'")).toEqual([{ revoked_by: null, revoked_reason: "user" }]);
    // The ban names the token as who did it.
    await lib.deactivate(ws, "mia@acme.com");
    expect(rows("SELECT ban_reason FROM users WHERE id = 'u-mia'")).toEqual([
      { ban_reason: `Deactivated by api-token:${ACCOUNT_ID} (pnpm everyapp workspace deactivate)` },
    ]);
  });
});

describe("workspace rename", () => {
  const names = () => rows("SELECT id, name, slug FROM organizations ORDER BY created_at");

  it("writes the name on the install's organization, keeps its slug, and says so", async () => {
    await renameWorkspace(opts(), "  Acme   Corp ");
    expect(names()[0]).toEqual({ id: ORG, name: "Acme Corp", slug: "acme" });
    expect(events.filter((event) => event["step"] === "workspace.rename")).toEqual([
      expect.objectContaining({ type: "step", status: "start" }),
      expect.objectContaining({
        type: "step",
        status: "ok",
        message: "Renamed Acme to Acme Corp",
        data: { id: ORG, name: "Acme Corp", previousName: "Acme", changed: true },
      }),
    ]);
    expect(done()).toMatchObject({
      message: "Renamed the workspace to Acme Corp. Members see the name on their next page.",
      data: { organization: { id: ORG, name: "Acme Corp", slug: "acme" }, previousName: "Acme", changed: true, gateway: "https://example.com" },
    });
    // The other organization is untouched.
    expect(names()[1]).toMatchObject({ id: OTHER_ORG, name: "Beta" });
  });

  it("says when the name is the same already, and writes nothing", async () => {
    account.cf.calls.length = 0;
    await renameWorkspace(opts(), "Acme");
    expect(names()[0]).toMatchObject({ name: "Acme", slug: "acme" });
    expect(done()).toMatchObject({
      message: "The workspace is named Acme already. Nothing changed.",
      data: { previousName: "Acme", changed: false },
    });
    expect(account.cf.calls.filter((call) => call.args.join(" ").includes("UPDATE organizations"))).toEqual([]);
  });

  it("refuses a bad name before logging in", async () => {
    createCf.mockClear();
    for (const name of ["", "   ", "x".repeat(65), "Acme\nCorp"]) {
      await expect(renameWorkspace(opts(), name), JSON.stringify(name)).rejects.toMatchObject({
        code: "WORKSPACE_NAME_INVALID",
        message: expect.stringContaining("Use 1 to 64 characters with no line breaks"),
        fix: "give the name as one argument, quoted when it has spaces",
      });
    }
    expect(createCf).not.toHaveBeenCalled();
    expect(names()[0]).toMatchObject({ name: "Acme" });
  });

  it("refuses a Gateway nobody has claimed: the claim would name the workspace over it", async () => {
    // Before the claim: an organization with no owner.
    sqlite().sqlite.prepare("DELETE FROM members WHERE role = 'owner'").run();
    await expect(renameWorkspace(opts(), "Acme Corp")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_CLAIMED",
      message: expect.stringContaining("The Gateway has no owner yet"),
    });
    expect(names()[0]).toMatchObject({ name: "Acme" });
  });
});

describe("workspace role", () => {
  const roleOf = (id: string) => rows("SELECT role FROM members WHERE user_id = ? AND organization_id = ?", id, ORG)[0]?.["role"];

  it("makes a member an owner, matching the address without case, and says so", async () => {
    await setRole(opts(), "Sam@Acme.com", "owner");
    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(roleOf("u-sam")).toBe("owner");
    expect(done()).toMatchObject({
      message: "sam@acme.com is now an owner of Acme. The Gateway picks up the change within 30 seconds.",
      data: {
        workspace: { id: ORG, name: "Acme" },
        member: { id: "u-sam", email: "sam@acme.com", name: "Sam" },
        role: "owner",
        previousRole: "member",
        changed: true,
      },
    });
  });

  it("lets one of two owners become an admin, and says when nothing changes", async () => {
    await setRole(opts(), "sam@acme.com", "owner");
    events = [];
    await setRole(opts(), "dev@example.com", "admin");
    expect(roleOf("u-owner")).toBe("admin");
    expect(roleOf("u-sam")).toBe("owner");
    expect(done()).toMatchObject({ message: expect.stringContaining("dev@example.com is now an admin of Acme") });

    events = [];
    await setRole(opts(), "dev@example.com", "admin");
    expect(done()).toMatchObject({
      message: "dev@example.com is already an admin of Acme. Nothing changed.",
      data: { role: "admin", changed: false },
    });
    expect(done()!["data"]["previousRole"]).toBeUndefined();
  });

  it("refuses to demote the last owner, leaving the row as it was", async () => {
    for (const role of ["admin", "member"] as const) {
      await expect(setRole(opts(), "dev@example.com", role)).rejects.toMatchObject({
        code: "LAST_OWNER",
        message: expect.stringContaining("dev@example.com is the last owner of Acme"),
        rerun: "pnpm everyapp workspace role <email> owner",
        data: { workspace: { id: ORG, name: "Acme" }, member: { id: "u-owner", email: "dev@example.com" }, role },
      });
    }
    expect(roleOf("u-owner")).toBe("owner");
  });

  /** Deactivated as the Gateway does it: banned, with no expiry (or one still to come). */
  const deactivate = (id: string, banExpires: number | null = null) =>
    sqlite().sqlite.prepare("UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?").run(banExpires, id);

  it("counts only owners who can act: a deactivated owner doesn't keep the last live one demotable", async () => {
    await setRole(opts(), "sam@acme.com", "owner");
    deactivate("u-owner");

    // Sam is the only owner who can sign in: their role stays.
    await expect(setRole(opts(), "sam@acme.com", "admin")).rejects.toMatchObject({
      code: "LAST_OWNER",
      message: expect.stringContaining("sam@acme.com is the last owner of Acme"),
    });
    expect(roleOf("u-sam")).toBe("owner");

    // The deactivated owner can lose the role: Sam remains.
    await setRole(opts(), "dev@example.com", "member");
    expect(roleOf("u-owner")).toBe("member");

    // A ban that has run out is no ban: dev counts again once an owner.
    deactivate("u-owner", Date.now() - 60_000);
    await setRole(opts(), "dev@example.com", "owner");
    await setRole(opts(), "sam@acme.com", "admin");
    expect(roleOf("u-sam")).toBe("admin");
    expect(roleOf("u-owner")).toBe("owner");

    // A ban still to run out is one: Sam is again the only owner who can act.
    deactivate("u-owner", Date.now() + 60_000);
    await setRole(opts(), "sam@acme.com", "owner");
    await expect(setRole(opts(), "sam@acme.com", "admin")).rejects.toMatchObject({
      code: "LAST_OWNER",
    });
    expect(roleOf("u-sam")).toBe("owner");
  });

  it("refuses an address that isn't a member's", async () => {
    await expect(setRole(opts(), "nobody@acme.com", "owner")).rejects.toMatchObject({
      code: "MEMBER_NOT_FOUND",
      message: expect.stringContaining("No member nobody@acme.com in Acme"),
      data: { email: "nobody@acme.com" },
    });
    expect(rows("SELECT role FROM members WHERE organization_id = ? AND role = 'owner'", ORG)).toHaveLength(1);
  });

  it("reads the role as typed, in any case, and refuses anything else", () => {
    expect(parseWorkspaceRole("Owner")).toBe("owner");
    expect(parseWorkspaceRole(" member ")).toBe("member");
    expect(() => parseWorkspaceRole("boss")).toThrow("Use owner, admin or member.");
  });
});
