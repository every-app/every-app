/**
 * `everyapp workspace …`: the organization's members, invitations, groups,
 * app access, caps, usage, activity, tokens and AI connections, read and
 * written in the Gateway's D1 under the operator's Cloudflare login
 * (ADR-0003: write access to the Gateway's D1 is operator authority), the
 * way `mcp on` and `email set` write the registry. The Gateway's own
 * services (apps/every-app-gateway/src/server/services) do the same work
 * for a signed-in admin; this file mirrors what they read and write, with
 * their guards as SQL conditions on the write itself, so a row that
 * changed between the read and the write is still refused: never the last
 * owner who can act (members.ts holds the predicate `workspace role` uses;
 * a deactivated owner doesn't count), only members of the organization in
 * its groups and grants, only a pending invitation canceled or re-linked.
 *
 * The operator is root in every organization of the Gateway. Where a
 * service's rule exists to stop one admin acting on another (an admin may
 * not change an admin, nobody manages themselves) it does not apply here;
 * where it protects the data (an organization always keeps an owner who
 * can act) it does. A ban is account-wide, so a deactivation keeps the
 * rule in every organization the person owns, not only the one acted on.
 *
 * Nothing here calls the Gateway over HTTPS, and nothing sends mail: a
 * command prints the link the Gateway would have mailed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import {
  AUDIT_PAGE_MAX,
  auditActorOf,
  auditSubjectOf,
  auditTypeCondition,
  auditTypeLabel,
  isAppOwnEventType,
  type AuditActor,
  type AuditSubject,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { listed } from "@/lib/output/text";
import { hasAiDefault } from "./aiDefault";
import { capAlertsStatement, operatorActor, queueEventFromCli, requireAuditColumns } from "./events";
import { anotherLiveOwnerSql } from "./members";
import { installOrganization, registryCall, text, type Deployer, type Organization } from "./registry";

type D1Row = Record<string, unknown>;

/**
 * The workspace `rename` acts on: the install's organization, once it has
 * an owner. Before the setup claim there is nothing to act on: the claim
 * names the organization after its owner (or `platformOrganizationName`),
 * so anything written before it would be overwritten.
 */
async function claimedWorkspace(db: D1Database): Promise<Organization> {
  const found = await installOrganization(db);
  if (!found || !found.hasOwner) {
    throw new EveryAppError(
      "WORKSPACE_NOT_CLAIMED",
      "The Gateway has no owner yet\nThe setup claim makes the workspace, named after its owner; rename it after.",
      { fix: "open the Gateway in a browser and claim it, then run this again" },
    );
  }
  return found.organization;
}

/**
 * Rename the install's organization to `name` (already valid by the shared
 * rule). Its slug stays, as the Gateway's own rename keeps it. Whether the
 * name changed, and what it was.
 */
export function renameInstallOrganization(
  db: D1Database,
  name: string,
): Promise<{ organization: Organization; previousName: string; changed: boolean }> {
  return registryCall(async () => {
    const organization = await claimedWorkspace(db);
    const changed = organization.name !== name;
    if (changed) {
      await db.run([
        { sql: "UPDATE organizations SET name = ? WHERE id = ?", params: [name, organization.id] },
      ]);
    }
    return {
      organization: { ...organization, name },
      previousName: organization.name,
      changed,
    };
  });
}

type WorkspaceRole = "owner" | "admin" | "member";

/** Who runs the command, as the Cloudflare login names them. */
interface Operator {
  /** The login's email, or `api-token:<account id>`. */
  actor: string;
  /** The login's email; null for an API token. */
  email: string | null;
  /** The Gateway user with that verified email, when there is one. */
  userId: string | null;
}

/** The organization a command acts on, and who acts. */
export interface Workspace {
  db: D1Database;
  organization: Organization;
  /** The install organization's id (what `workspace role` acts on); null before the claim. */
  installOrganizationId: string | null;
  operator: Operator;
  /** Milliseconds now, for every timestamp this run writes. */
  now: number;
}

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  /** The row's role as stored (a comma list is possible). */
  role: string;
  /** The role that counts, as the Gateway resolves it. */
  primaryRole: WorkspaceRole | null;
  /** Banned now (users.banned, with ban_expires still to come or unset). */
  deactivated: boolean;
  createdAt: number;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: number;
  createdAt: number;
  /** Whether it can still be accepted: pending, and not past its expiry. */
  live: boolean;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  memberCount: number;
  appCount: number;
}

/** An `apps` row as the workspace commands read it (never a tombstone). */
export interface WorkspaceApp {
  id: string;
  appSlug: string;
  name: string;
  description: string;
  status: string;
  scope: string;
  tier: string;
  hostname: string | null;
  /** "Available to everyone": every member now and on joining. */
  everyone: boolean;
  manifest: string | null;
  secretNames: string | null;
  /** Distinct members who can open it, directly or through a group. */
  accessCount: number;
}

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_LINK_TTL_MS = 60 * 60 * 1000;
/** Caps are whole provider calls per month, up to a billion (AppCapService). */
export const MONTHLY_CALL_CAP_MAX = 1_000_000_000;
/** Group names are 1 to 60 characters, trimmed (GroupService). */
const GROUP_NAME_MAX = 60;
/** App names are 1 to 255 characters (schemas/app.ts, what Admin → Apps → Edit takes). */
const APP_NAME_MAX = 255;
/** D1 binds at most 100 parameters per statement. */
const IDS_PER_STATEMENT = 90;
const ROWS_PER_INSERT = 19;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** SQL: the role column names `owner` (the stored role may be a comma list). */
const isOwnerSql = (column: string) =>
  `((',' || replace(${column}, ' ', '') || ',') LIKE '%,owner,%')`;

/**
 * SQL: the member row's `column` (user `?1`) isn't the last owner who can
 * act of organization `?2` at `?3`: not an owner, or one of several who
 * are live (members.ts `anotherLiveOwnerSql`, the predicate `workspace
 * role` holds in its own write; a deactivated owner doesn't count).
 */
const NOT_LAST_LIVE_OWNER_HERE = (column: string) =>
  `(NOT ${isOwnerSql(column)} OR ${anotherLiveOwnerSql("?2", "?1", "?3")})`;

/**
 * SQL: the user `?1` is a member of organization `?2` whose going would
 * not leave it without an owner who can act (`?3` the time;
 * MembershipService's rule: owners are peers, and an organization always
 * keeps one). Every write that takes a member out of the organization
 * carries it, so the guard holds on the write itself, not only on the read
 * before it.
 */
const MANAGEABLE_MEMBER = `EXISTS (SELECT 1 FROM members m WHERE m.user_id = ?1 AND m.organization_id = ?2 AND ${NOT_LAST_LIVE_OWNER_HERE("m.role")})`;

/**
 * SQL: the user `?1` is a member of organization `?2`, and the last owner
 * who can act of no organization at all (`?3` the time). A ban is
 * account-wide (`users.banned`; every session, token and AI connection
 * goes with it), so a deactivation through one organization must keep the
 * rule in every organization the person owns: the Gateway refuses such a
 * person to an admin outright (USER_IN_OTHER_ORGANIZATION); the operator,
 * root everywhere, is held to the rule itself.
 */
const DEACTIVATABLE_MEMBER = `EXISTS (SELECT 1 FROM members m WHERE m.user_id = ?1 AND m.organization_id = ?2)
  AND NOT EXISTS (SELECT 1 FROM members mine WHERE mine.user_id = ?1 AND ${isOwnerSql("mine.role")}
    AND NOT ${anotherLiveOwnerSql("mine.organization_id", "?1", "?3")})`;

/** SQL: isUserBanned (apps/every-app-gateway/src/server/user-ban.ts), `?now` the time. */
const bannedSql = (now: string) =>
  `(banned = 1 AND (ban_expires IS NULL OR ban_expires > ${now}))`;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** The role that counts: owner over admin over member, as the Gateway resolves a stored role. */
function primaryRole(stored: string | null): WorkspaceRole | null {
  const roles = (stored ?? "").split(",").map((role) => role.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  if (roles.includes("member")) return "member";
  return null;
}

const number = (value: unknown): number => Number(value ?? 0);

function toMember(row: D1Row, now: number): WorkspaceMember {
  const banned = Number(row["banned"] ?? 0) === 1;
  const banExpires = row["ban_expires"] == null ? null : Number(row["ban_expires"]);
  return {
    id: String(row["id"]),
    name: String(row["name"] ?? ""),
    email: String(row["email"]),
    role: String(row["role"] ?? "member"),
    primaryRole: primaryRole(text(row["role"])),
    deactivated: banned && (banExpires === null || banExpires > now),
    createdAt: number(row["created_at"]),
  };
}

function toInvitation(row: D1Row, now: number): WorkspaceInvitation {
  const status = String(row["status"]);
  const expiresAt = number(row["expires_at"]);
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    role: String(row["role"] ?? "member"),
    status,
    expiresAt,
    createdAt: number(row["created_at"]),
    live: status === "pending" && expiresAt > now,
  };
}

function toGroup(row: D1Row): WorkspaceGroup {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    description: text(row["description"]),
    createdAt: number(row["created_at"]),
    memberCount: number(row["member_count"]),
    appCount: number(row["app_count"]),
  };
}

function toApp(row: D1Row): WorkspaceApp {
  return {
    id: String(row["id"]),
    appSlug: String(row["app_slug"]),
    name: String(row["name"]),
    description: String(row["description"] ?? ""),
    status: String(row["status"]),
    scope: String(row["scope"]),
    tier: String(row["tier"]),
    hostname: text(row["hostname"]),
    everyone: Number(row["is_default"] ?? 0) === 1,
    manifest: text(row["manifest"]),
    secretNames: text(row["secret_names"]),
    accessCount: number(row["access_count"]),
  };
}

const MEMBER_COLUMNS =
  "u.id, u.name, u.email, m.role, u.banned, u.ban_expires, u.created_at";

const APP_COLUMNS = `a.id, a.app_slug, a.name, a.description, a.status, a.scope, a.tier, a.hostname, a.is_default, a.manifest, a.secret_names,
  (SELECT COUNT(DISTINCT g.user_id) FROM (
     SELECT ua.user_id FROM user_app_access ua WHERE ua.app_row_id = a.id AND ua.organization_id = a.organization_id
     UNION ALL
     SELECT gm.user_id FROM group_app_access ga JOIN group_members gm ON gm.group_id = ga.group_id
       WHERE ga.app_row_id = a.id AND ga.organization_id = a.organization_id AND gm.organization_id = a.organization_id
   ) g JOIN members mm ON mm.user_id = g.user_id AND mm.organization_id = a.organization_id) AS access_count`;

const toOrganization = (row: D1Row): Organization => ({
  id: String(row["id"]),
  name: String(row["name"]),
  slug: String(row["slug"]),
});

/**
 * The organization `--org` names: by id or slug, each unique, else by name
 * (letter case aside). Names aren't unique (`organizations` is unique on
 * `slug` only) and any owner or admin can rename theirs, so a name two
 * organizations share is refused rather than resolved to the older one: a
 * script that says `--org Beta` must not find itself removing a member
 * from, or granting an app in, an organization someone renamed to Beta.
 */
async function resolveOrganization(db: D1Database, named: string): Promise<Organization> {
  const wanted = named.trim();
  const [rows = [], all = []] = await db.run([
    {
      sql: `SELECT id, name, slug FROM organizations
WHERE id = ?1 OR slug = ?1 OR lower(name) = lower(?1)
ORDER BY created_at, id`,
      params: [wanted],
    },
    { sql: "SELECT id, name, slug FROM organizations ORDER BY created_at, id" },
  ]);
  const matches = rows.map(toOrganization);
  const exact = matches.find((match) => match.id === wanted) ?? matches.find((match) => match.slug === wanted);
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new EveryAppError(
      "ORG_AMBIGUOUS",
      `${matches.length} organizations are named ${wanted}: ${listed(matches.map((match) => `${match.slug} (${match.id})`))}\nA name isn't unique, and any owner or admin can rename their organization; a slug or id is one organization's.`,
      { fix: "name it by its slug or id with --org", data: { organizations: matches } },
    );
  }
  const organizations = all.map(toOrganization);
  throw new EveryAppError(
    "ORGANIZATION_NOT_FOUND",
    `No organization named ${wanted} on this Gateway${organizations.length > 0 ? `\nThe Gateway has: ${listed(organizations.map((organization) => `${organization.slug} (${organization.name})`))}.` : ""}`,
    { fix: "name one by its slug, id or name with --org", data: { organizations } },
  );
}

/** The Gateway user with the login's verified email, as the registry finds the deployer. */
async function operatorFor(db: D1Database, deployer: Deployer): Promise<Operator> {
  if (deployer.email === null) return { actor: deployer.actor, email: null, userId: null };
  const [rows = []] = await db.run([
    {
      sql: "SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified = 1",
      params: [deployer.email],
    },
  ]);
  return { actor: deployer.actor, email: deployer.email, userId: text(rows[0]?.["id"]) };
}

/** Without `--org`, before the claim: there is no install organization to act on. */
const noOrganizationYet = () =>
  new EveryAppError(
    "ORGANIZATION_NOT_FOUND",
    "The Gateway has no organization yet\nIts owner creates the first one by claiming it.",
    { rerun: `${CLI} setup`, rerunNote: "prints the owner link" },
  );

/**
 * The organization a Gateway command that takes `--org` acts on: the one
 * `org` names (resolveOrganization: id, slug, then a name only one
 * organization has), or the install one (the oldest with an owner)
 * without it. `openWorkspace` adds who acts; `everyapp events` needs only
 * this. Reads only.
 */
export async function organizationFor(db: D1Database, org?: string): Promise<Organization> {
  if (org !== undefined) return resolveOrganization(db, org);
  const install = await installOrganization(db);
  if (!install) throw noOrganizationYet();
  return install.organization;
}

/**
 * The workspace a command acts on: `--org`'s organization, or the install
 * one (the oldest with an owner) without it, and who acts.
 */
export async function openWorkspace(
  db: D1Database,
  deployer: Deployer,
  options: { org?: string; now?: number } = {},
): Promise<Workspace> {
  const [install, operator] = await Promise.all([installOrganization(db), operatorFor(db, deployer)]);
  if (options.org === undefined && !install) throw noOrganizationYet();
  const organization =
    options.org === undefined ? install!.organization : await resolveOrganization(db, options.org);
  return {
    db,
    organization,
    installOrganizationId: install?.organization.id ?? null,
    operator,
    now: options.now ?? Date.now(),
  };
}

/** A member of the organization by email or user id. */
export async function findMember(ws: Workspace, identifier: string): Promise<WorkspaceMember> {
  const wanted = identifier.trim();
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${MEMBER_COLUMNS} FROM members m JOIN users u ON u.id = m.user_id
WHERE m.organization_id = ?1 AND (lower(u.email) = lower(?2) OR u.id = ?2)
ORDER BY (u.id = ?2) DESC LIMIT 1`,
      params: [ws.organization.id, wanted],
    },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError(
      "USER_NOT_FOUND",
      `${wanted} isn't a member of ${ws.organization.name}`,
      { rerun: `${CLI} workspace users`, rerunNote: "lists the members and invitations" },
    );
  }
  return toMember(row, ws.now);
}

/**
 * One of the organization's own apps (a deleted app's tombstone aside) by
 * its id (`crm`) or row id. With `callable`, a shared app too: an
 * organization caps a shared app on its own.
 */
export async function findApp(
  ws: Workspace,
  identifier: string,
  { callable = false }: { callable?: boolean } = {},
): Promise<WorkspaceApp> {
  const wanted = identifier.trim();
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps a
WHERE (a.organization_id = ?1${callable ? " OR a.scope = 'shared'" : ""}) AND a.status != '${DELETED_APP_STATUS}'
  AND (a.app_slug = ?2 OR a.id = ?2)
ORDER BY (a.organization_id = ?1) DESC, (a.id = ?2) DESC LIMIT 1`,
      params: [ws.organization.id, wanted],
    },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError("APP_NOT_FOUND", `No app named ${wanted} in ${ws.organization.name}`, {
      rerun: `${CLI} workspace apps`,
      rerunNote: "lists them",
    });
  }
  return toApp(row);
}

/** A group of the organization by name (letter case aside) or `grp_` id. */
export async function findGroup(ws: Workspace, identifier: string): Promise<WorkspaceGroup> {
  const wanted = identifier.trim();
  const [rows = []] = await ws.db.run([
    {
      sql: `${GROUPS_SQL} AND (g.id = ?2 OR lower(g.name) = lower(?2)) ORDER BY (g.id = ?2) DESC LIMIT 1`,
      params: [ws.organization.id, wanted],
    },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError("GROUP_NOT_FOUND", `No group named ${wanted} in ${ws.organization.name}`, {
      rerun: `${CLI} workspace groups`,
      rerunNote: "lists them",
    });
  }
  return toGroup(row);
}

/** A pending invitation by id or invited email (the newest, for an email). */
async function findPendingInvitation(
  ws: Workspace,
  identifier: string,
): Promise<WorkspaceInvitation> {
  const wanted = identifier.trim();
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT id, email, role, status, expires_at, created_at FROM invitations
WHERE organization_id = ?1 AND status = 'pending' AND (id = ?2 OR lower(email) = lower(?2))
ORDER BY (id = ?2) DESC, created_at DESC LIMIT 1`,
      params: [ws.organization.id, wanted],
    },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError(
      "INVITATION_NOT_PENDING",
      `No pending invitation for ${wanted} in ${ws.organization.name}\nIt was accepted, canceled or never made.`,
      { rerun: `${CLI} workspace users`, rerunNote: "lists the pending invitations" },
    );
  }
  return toInvitation(row, ws.now);
}

/** What `workspace show` reports. */
interface WorkspaceSummary {
  organization: Organization;
  owners: string[];
  counts: { members: number; deactivated: number; invitations: number; groups: number; apps: number };
}

export async function summarize(ws: Workspace): Promise<WorkspaceSummary> {
  const org = ws.organization.id;
  const [owners = [], counts = []] = await ws.db.run([
    {
      sql: `SELECT u.email FROM members m JOIN users u ON u.id = m.user_id
WHERE m.organization_id = ?1 AND ${isOwnerSql("m.role")} ORDER BY m.created_at, u.email`,
      params: [org],
    },
    {
      sql: `SELECT
  (SELECT COUNT(*) FROM members WHERE organization_id = ?1) AS members,
  (SELECT COUNT(*) FROM members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?1 AND ${bannedSql("?2")}) AS deactivated,
  (SELECT COUNT(*) FROM invitations WHERE organization_id = ?1 AND status = 'pending' AND expires_at > ?2) AS invitations,
  (SELECT COUNT(*) FROM groups WHERE organization_id = ?1) AS groups,
  (SELECT COUNT(*) FROM apps WHERE organization_id = ?1 AND status != '${DELETED_APP_STATUS}') AS apps`,
      params: [org, ws.now],
    },
  ]);
  const row = counts[0] ?? {};
  return {
    organization: ws.organization,
    owners: owners.map((owner) => String(owner["email"])),
    counts: {
      members: number(row["members"]),
      deactivated: number(row["deactivated"]),
      invitations: number(row["invitations"]),
      groups: number(row["groups"]),
      apps: number(row["apps"]),
    },
  };
}

/** The members, owners first, then the pending invitations (AdminService.listMembers). */
export async function listUsers(
  ws: Workspace,
): Promise<{ members: WorkspaceMember[]; invitations: WorkspaceInvitation[] }> {
  const [members = [], invitations = []] = await ws.db.run([
    {
      sql: `SELECT ${MEMBER_COLUMNS} FROM members m JOIN users u ON u.id = m.user_id
WHERE m.organization_id = ?1 ORDER BY u.email`,
      params: [ws.organization.id],
    },
    {
      sql: `SELECT id, email, role, status, expires_at, created_at FROM invitations
WHERE organization_id = ?1 AND status = 'pending' ORDER BY created_at DESC`,
      params: [ws.organization.id],
    },
  ]);
  const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
  return {
    members: members
      .map((row) => toMember(row, ws.now))
      .sort(
        (a, b) =>
          (rank[a.primaryRole ?? "member"] ?? 3) - (rank[b.primaryRole ?? "member"] ?? 3) ||
          a.email.localeCompare(b.email),
      ),
    invitations: invitations.map((row) => toInvitation(row, ws.now)),
  };
}

/** An invite link's secret (`einv_` + 32 random bytes), and the hash the Gateway stores. */
function newInvitationToken(): { token: string; hash: string } {
  const token = `einv_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

export const invitationUrl = (gatewayUrl: string, token: string) =>
  `${gatewayUrl}/accept-invitation?token=${encodeURIComponent(token)}`;

export const passwordResetUrl = (gatewayUrl: string, token: string) =>
  `${gatewayUrl}/reset-password?token=${encodeURIComponent(token)}`;

/** Invite someone: the invitation row and a link for it. */
interface InviteResult {
  invitation: WorkspaceInvitation;
  /** The link's secret, to print once. */
  token: string;
}

/**
 * Invite an email address to the organization (InvitationService.invite,
 * without the mail): a pending invitation for 72 hours, with the operator
 * as its inviter, and one link token, stored as its SHA-256. The
 * invitation needs an inviter, so the operator must have an account on
 * the Gateway that is a member of this organization; an address that is
 * a member already, or has a live invitation, is refused.
 */
export async function invite(
  ws: Workspace,
  email: string,
  role: "member" | "admin",
): Promise<InviteResult> {
  const address = email.trim().toLowerCase();
  const inviter = await requireOperatorMembership(ws, "invite");
  await refuseKnownAddress(ws, address);
  const id = randomUUID();
  const { token, hash } = newInvitationToken();
  const expiresAt = ws.now + INVITATION_TTL_MS;
  const [, , written = []] = await ws.db.run([
    {
      // The checks again, on the write: a sign-up or an invite racing this one loses.
      sql: `INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7
WHERE NOT EXISTS (SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?2 AND lower(u.email) = ?3)
  AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = ?2 AND lower(i.email) = ?3 AND i.status = 'pending' AND i.expires_at > ?6)`,
      params: [id, ws.organization.id, address, role, expiresAt, ws.now, inviter],
    },
    {
      sql: `INSERT INTO invitation_link_tokens (id, invitation_id, token_hash, created_at)
SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ?2)`,
      params: [randomUUID(), id, hash, ws.now],
    },
    {
      sql: "SELECT id, email, role, status, expires_at, created_at FROM invitations WHERE id = ?",
      params: [id],
    },
  ]);
  const row = written[0];
  if (!row) {
    // Something raced the read: say which guard held.
    await refuseKnownAddress(ws, address);
    throw new EveryAppError("ALREADY_INVITED", `${address} was invited meanwhile`, { retryable: true });
  }
  return { invitation: toInvitation(row, ws.now), token };
}

/** The operator's user id, as a member of this organization: what an invitation records. */
async function requireOperatorMembership(ws: Workspace, action: string): Promise<string> {
  const { operator } = ws;
  if (operator.userId !== null) {
    const [rows = []] = await ws.db.run([
      {
        sql: "SELECT 1 AS member FROM members WHERE user_id = ? AND organization_id = ?",
        params: [operator.userId, ws.organization.id],
      },
    ]);
    if (rows.length > 0) return operator.userId;
  }
  const who =
    operator.email === null
      ? "An API token has no account on the Gateway"
      : operator.userId === null
        ? `${operator.email} has no account on this Gateway (a verified one)`
        : `${operator.email} isn't a member of ${ws.organization.name}`;
  throw new EveryAppError(
    "WORKSPACE_NOT_A_MEMBER",
    `Only a member can ${action}: an invitation records who sent it\n${who}.`,
    {
      fix:
        operator.email === null
          ? `log in with your Cloudflare account (${CLI} login), claim the Gateway (${CLI} setup) or get invited, or invite from Admin → Users`
          : `claim the Gateway (${CLI} setup) or get invited to ${ws.organization.name}, or invite from Admin → Users`,
    },
  );
}

/** An address that is a member already, or has a live invitation, is refused. */
async function refuseKnownAddress(ws: Workspace, address: string): Promise<void> {
  const [members = [], invitations = []] = await ws.db.run([
    {
      sql: `SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?1 AND lower(u.email) = ?2`,
      params: [ws.organization.id, address],
    },
    {
      sql: `SELECT id FROM invitations WHERE organization_id = ?1 AND lower(email) = ?2 AND status = 'pending' AND expires_at > ?3`,
      params: [ws.organization.id, address, ws.now],
    },
  ]);
  if (members.length > 0) {
    throw new EveryAppError("ALREADY_MEMBER", `${address} is a member of ${ws.organization.name} already`, {
      rerun: `${CLI} workspace users`,
      rerunNote: "lists the members",
    });
  }
  if (invitations.length > 0) {
    throw new EveryAppError(
      "ALREADY_INVITED",
      `${address} has a pending invitation to ${ws.organization.name} already`,
      { rerun: `${CLI} workspace invite-link ${address}`, rerunNote: "prints a new link for it" },
    );
  }
}

/** A new link for a pending, unexpired invitation (InvitationService.getInvitationLink). */
export async function inviteLink(ws: Workspace, identifier: string): Promise<InviteResult> {
  const invitation = await findPendingInvitation(ws, identifier);
  if (!invitation.live) {
    throw new EveryAppError(
      "INVITATION_NOT_PENDING",
      `The invitation for ${invitation.email} expired on ${new Date(invitation.expiresAt).toISOString()}`,
      { rerun: `${CLI} workspace invite ${invitation.email}`, rerunNote: "makes a new one" },
    );
  }
  const { token, hash } = newInvitationToken();
  const [written = []] = await ws.db.run([
    {
      sql: `INSERT INTO invitation_link_tokens (id, invitation_id, token_hash, created_at)
SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ?2 AND status = 'pending' AND expires_at > ?4)
RETURNING id`,
      params: [randomUUID(), invitation.id, hash, ws.now],
    },
  ]);
  if (written.length === 0) {
    throw new EveryAppError("INVITATION_NOT_PENDING", `The invitation for ${invitation.email} was used or canceled meanwhile`);
  }
  return { invitation, token };
}

/** Cancel a pending invitation (AdminService.cancelInvitation): its links stop working. */
export async function uninvite(ws: Workspace, identifier: string): Promise<WorkspaceInvitation> {
  const invitation = await findPendingInvitation(ws, identifier);
  const [changed = []] = await ws.db.run([
    {
      sql: "UPDATE invitations SET status = 'canceled' WHERE id = ? AND organization_id = ? AND status = 'pending' RETURNING id",
      params: [invitation.id, ws.organization.id],
    },
  ]);
  if (changed.length === 0) {
    throw new EveryAppError("INVITATION_NOT_PENDING", `The invitation for ${invitation.email} was used or canceled meanwhile`);
  }
  return { ...invitation, status: "canceled", live: false };
}

/**
 * The refusal a write on the last owner who can act gets: an organization
 * always keeps one. `organization` is the one that would be left without:
 * the one acted on, or, for a deactivation (account-wide), another the
 * member owns. `workspace role` hands the role out in the install
 * organization only; elsewhere an owner of that organization does it in
 * the Gateway.
 */
function lastOwner(
  ws: Workspace,
  member: WorkspaceMember,
  action: string,
  organization: Organization,
): EveryAppError {
  const here = organization.id === ws.organization.id;
  const headline = here
    ? `${member.email} is the last owner of ${organization.name} who can act, so they can't be ${action}`
    : `${member.email} is the last owner of ${organization.name} who can act, and a deactivation is account-wide: it would leave ${organization.name} without one`;
  const next =
    organization.id === ws.installOrganizationId
      ? { rerun: `${CLI} workspace role <email> owner`, rerunNote: "for someone else, then this command again" }
      : {
          fix: `an owner of ${organization.name} makes someone else an owner under Manage workspace → Users, then run this again`,
        };
  return new EveryAppError(
    "LAST_OWNER",
    `${headline}\nMake someone else an owner of ${organization.name} first, then try again.`,
    { ...next, data: { organization, member: { id: member.id, email: member.email, name: member.name } } },
  );
}

/**
 * The organizations the user is the last owner who can act of: every one
 * they belong to (`everywhere`, what a ban must keep), or the one acted
 * on alone (what a removal must keep). The one acted on comes first.
 */
async function lastLiveOwnerOf(ws: Workspace, userId: string, everywhere: boolean): Promise<Organization[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT o.id, o.name, o.slug FROM members mine JOIN organizations o ON o.id = mine.organization_id
WHERE mine.user_id = ?1 AND ${everywhere ? "1" : "mine.organization_id = ?3"} AND ${isOwnerSql("mine.role")}
  AND NOT ${anotherLiveOwnerSql("mine.organization_id", "?1", "?2")}
ORDER BY (mine.organization_id = ?3) DESC, o.created_at, o.id`,
      params: [userId, ws.now, ws.organization.id],
    },
  ]);
  return rows.map(toOrganization);
}

/**
 * Refuse the last owner who can act before the write (the friendlier
 * refusal, naming the organization); the write holds the same rule, and
 * `afterWrite` says it again when the write changed nothing (the member
 * left as the last live owner between the read and the write).
 */
async function refuseLastLiveOwner(
  ws: Workspace,
  member: WorkspaceMember,
  action: string,
  everywhere: boolean,
  { afterWrite = false } = {},
): Promise<void> {
  const fresh = afterWrite ? await findMember(ws, member.id) : member;
  const blocking = await lastLiveOwnerOf(ws, fresh.id, everywhere);
  if (blocking[0]) throw lastOwner(ws, fresh, action, blocking[0]);
  if (afterWrite) throw lastOwner(ws, fresh, action, ws.organization);
}

/**
 * What a deactivation writes (UserRepository.deactivate, then the AI
 * connections). Every statement carries the account-wide last-owner rule:
 * a person left as the last live owner of any organization between the
 * read and the write is banned nowhere, and keeps their sessions, tokens
 * and connections.
 */
function deactivationWrites(ws: Workspace, member: WorkspaceMember, reason: string): D1Statement[] {
  // Each statement carries exactly the parameters it names: D1 refuses extras.
  const whoNow = [member.id, ws.organization.id, ws.now];
  return [
    {
      sql: `UPDATE users SET banned = 1, ban_reason = ?4, ban_expires = NULL, updated_at = ?3
WHERE id = ?1 AND ${DEACTIVATABLE_MEMBER} RETURNING id`,
      params: [...whoNow, reason],
    },
    { sql: `DELETE FROM sessions WHERE user_id = ?1 AND ${DEACTIVATABLE_MEMBER}`, params: whoNow },
    {
      sql: `UPDATE user_access_tokens SET revoked_at = ?3, updated_at = ?3
WHERE user_id = ?1 AND revoked_at IS NULL AND ${DEACTIVATABLE_MEMBER}`,
      params: whoNow,
    },
    {
      sql: `UPDATE mcp_connections SET revoked_at = ?3, revoked_reason = 'user_deactivated'
WHERE user_id = ?1 AND revoked_at IS NULL AND ${DEACTIVATABLE_MEMBER}`,
      params: whoNow,
    },
  ];
}

/**
 * Lock a member out everywhere at once (MembershipService.deactivate):
 * banned, every session ended, their personal access tokens and AI
 * connections revoked. Account-wide: the ban holds in every organization
 * they belong to, so never the last owner who can act of any of them (the
 * refusal names the organization that would be left without one). Returns
 * whether they were deactivated already.
 */
export async function deactivate(
  ws: Workspace,
  identifier: string,
): Promise<{ member: WorkspaceMember; already: boolean }> {
  const member = await findMember(ws, identifier);
  await refuseLastLiveOwner(ws, member, "deactivated", true);
  const [changed = []] = await ws.db.run(
    deactivationWrites(ws, member, `Deactivated by ${ws.operator.actor} (${CLI} workspace deactivate)`),
  );
  if (changed.length === 0) await refuseLastLiveOwner(ws, member, "deactivated", true, { afterWrite: true });
  return { member: { ...member, deactivated: true }, already: member.deactivated };
}

/** Lift a deactivation (MembershipService.reactivate): revoked tokens and connections stay revoked. */
export async function reactivate(
  ws: Workspace,
  identifier: string,
): Promise<{ member: WorkspaceMember; already: boolean }> {
  const member = await findMember(ws, identifier);
  await ws.db.run([
    {
      sql: `UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = ?3
WHERE id = ?1 AND EXISTS (SELECT 1 FROM members m WHERE m.user_id = ?1 AND m.organization_id = ?2)`,
      params: [member.id, ws.organization.id, ws.now],
    },
  ]);
  return { member: { ...member, deactivated: false }, already: !member.deactivated };
}

interface RemoveResult {
  member: WorkspaceMember;
  /** Access would let them straight back in, so they were deactivated and kept listed instead. */
  deactivatedInstead: boolean;
  /** The account went too: it belonged to no other organization. */
  accountDeleted: boolean;
  /** They belong to other organizations, where their account stays. */
  otherOrganizations: number;
}

/**
 * Take a member out of the organization (AdminService.deleteUser): the
 * membership, their grants and places in its groups, their tokens for it
 * (revoked) and AI connections to it (revoked), in one batch; then the
 * account, when it belongs to no other organization and
 * `deleteAccounts` (the self-hosted policy; a hosted Gateway keeps it).
 * Someone Cloudflare Access would let straight back in (`accessMayLetBackIn`)
 * is deactivated instead, as the Gateway does, and stays listed. Never the
 * organization's last owner who can act; someone who owns another
 * organization keeps their account there, whatever they are here.
 */
export async function remove(
  ws: Workspace,
  identifier: string,
  options: { deleteAccounts: boolean; accessMayLetBackIn: (member: WorkspaceMember) => Promise<boolean> },
): Promise<RemoveResult> {
  const member = await findMember(ws, identifier);
  await refuseLastLiveOwner(ws, member, "removed", false);
  const [others = []] = await ws.db.run([
    {
      sql: "SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND organization_id != ?",
      params: [member.id, ws.organization.id],
    },
  ]);
  const otherOrganizations = number(others[0]?.["n"]);
  if (otherOrganizations === 0 && (await options.accessMayLetBackIn(member))) {
    // Only this organization's member: the account-wide rule the ban holds is this organization's.
    const [changed = []] = await ws.db.run(
      deactivationWrites(
        ws,
        member,
        `Removed by ${ws.operator.actor} (${CLI} workspace remove); deactivated instead, as Cloudflare Access would let them back in`,
      ),
    );
    if (changed.length === 0) await refuseLastLiveOwner(ws, member, "removed", true, { afterWrite: true });
    return { member: { ...member, deactivated: true }, deactivatedInstead: true, accountDeleted: false, otherOrganizations };
  }
  const whoNow = [member.id, ws.organization.id, ws.now];
  const [, , , , removed = [], deleted = []] = await ws.db.run([
    { sql: `DELETE FROM user_app_access WHERE user_id = ?1 AND organization_id = ?2 AND ${MANAGEABLE_MEMBER}`, params: whoNow },
    { sql: `DELETE FROM group_members WHERE user_id = ?1 AND organization_id = ?2 AND ${MANAGEABLE_MEMBER}`, params: whoNow },
    {
      sql: `UPDATE user_access_tokens SET revoked_at = ?3, updated_at = ?3
WHERE user_id = ?1 AND organization_id = ?2 AND revoked_at IS NULL AND ${MANAGEABLE_MEMBER}`,
      params: whoNow,
    },
    {
      sql: `UPDATE mcp_connections SET revoked_at = ?3, revoked_reason = 'member_removed'
WHERE user_id = ?1 AND organization_id = ?2 AND revoked_at IS NULL AND ${MANAGEABLE_MEMBER}`,
      params: whoNow,
    },
    {
      sql: `DELETE FROM members WHERE user_id = ?1 AND organization_id = ?2 AND ${NOT_LAST_LIVE_OWNER_HERE("role")} RETURNING id`,
      params: whoNow,
    },
    options.deleteAccounts
      ? {
          // Only once the membership above went, and no other remains.
          sql: "DELETE FROM users WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ?1) RETURNING id",
          params: [member.id],
        }
      : { sql: "SELECT NULL AS id WHERE 0" },
  ]);
  if (removed.length === 0) await refuseLastLiveOwner(ws, member, "removed", false, { afterWrite: true });
  return { member, deactivatedInstead: false, accountDeleted: deleted.length > 0, otherOrganizations };
}

/**
 * A one-hour, single-use password-reset link to hand over
 * (MembershipService.createPasswordResetLink): Better Auth's own reset
 * token, a `verifications` row the regular /reset-password page consumes.
 * Only for an active account that belongs to this organization alone: a
 * deactivated one is refused, and so is a member of another organization
 * too (the Gateway's `requireAccountWideManageable`: a password is
 * account-wide, so a reset through one organization reaches the others).
 */
export async function resetLink(
  ws: Workspace,
  identifier: string,
): Promise<{ member: WorkspaceMember; token: string; expiresAt: number }> {
  const member = await findMember(ws, identifier);
  if (member.deactivated) {
    throw new EveryAppError(
      "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      `${member.email} is deactivated, and a password-reset link is only for an active account`,
      { rerun: `${CLI} workspace reactivate ${member.email}`, rerunNote: "first, if they should be back" },
    );
  }
  const [others = []] = await ws.db.run([
    {
      sql: `SELECT o.id, o.name, o.slug FROM members m JOIN organizations o ON o.id = m.organization_id
WHERE m.user_id = ?1 AND m.organization_id != ?2 ORDER BY o.created_at, o.id`,
      params: [member.id, ws.organization.id],
    },
  ]);
  if (others.length > 0) {
    const organizations = others.map(toOrganization);
    throw new EveryAppError(
      "USER_IN_OTHER_ORGANIZATION",
      `${member.email} also belongs to ${listed(organizations.map((organization) => organization.name))}, and a password is account-wide\nThe Gateway's own rule: a password-reset link is never made for someone in another organization, since it would reach that one too.`,
      {
        fix: "they reset it themselves with Forgot password (the Gateway's email must be configured), or they are removed from the other organization first",
        data: { member: { id: member.id, email: member.email, name: member.name }, organizations },
      },
    );
  }
  const token = randomBytes(24).toString("base64url");
  const expiresAt = ws.now + RESET_LINK_TTL_MS;
  await ws.db.run([
    {
      sql: `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      params: [randomUUID(), `reset-password:${token}`, member.id, expiresAt, ws.now],
    },
  ]);
  return { member, token, expiresAt };
}

const GROUPS_SQL = `SELECT g.id, g.name, g.description, g.created_at,
  (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
  (SELECT COUNT(*) FROM group_app_access ga JOIN apps a ON a.id = ga.app_row_id AND a.status != '${DELETED_APP_STATUS}' WHERE ga.group_id = g.id) AS app_count
FROM groups g WHERE g.organization_id = ?1`;

/** The organization's groups with their counts (GroupRepository.listByOrganization). */
export async function listGroups(ws: Workspace): Promise<WorkspaceGroup[]> {
  const [rows = []] = await ws.db.run([
    { sql: `${GROUPS_SQL} ORDER BY g.name`, params: [ws.organization.id] },
  ]);
  return rows.map(toGroup);
}

/** A group name as the Gateway takes one: trimmed, 1 to 60 characters. */
function groupName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > GROUP_NAME_MAX) {
    throw new EveryAppError("GROUP_NAME_INVALID", `A group name is 1 to ${GROUP_NAME_MAX} characters${trimmed ? ` (${trimmed.length} given)` : ""}`);
  }
  return trimmed;
}

function groupNameTaken(name: string): EveryAppError {
  return new EveryAppError("GROUP_NAME_TAKEN", `A group named "${name}" exists already in this organization`, {
    rerun: `${CLI} workspace groups`,
    rerunNote: "lists them",
  });
}

/** "grp_" + 16 hex, as the Gateway names groups. */
const newGroupId = () => `grp_${randomBytes(8).toString("hex")}`;

/** Make a group (GroupService.createGroup); names are unique in the organization, letter case aside. */
export async function createGroup(
  ws: Workspace,
  input: { name: string; description?: string | null },
): Promise<WorkspaceGroup> {
  const name = groupName(input.name);
  const description = input.description?.trim() || null;
  const id = newGroupId();
  const [written = []] = await ws.db.run([
    {
      sql: `INSERT INTO groups (id, organization_id, name, description, created_at, created_by)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE organization_id = ?2 AND lower(name) = lower(?3))
RETURNING id`,
      params: [id, ws.organization.id, name, description, ws.now, ws.operator.userId],
    },
  ]);
  if (written.length === 0) throw groupNameTaken(name);
  return { id, name, description, createdAt: ws.now, memberCount: 0, appCount: 0 };
}

/** Rename or describe a group (GroupService.updateGroup); what isn't given stays. */
export async function updateGroup(
  ws: Workspace,
  identifier: string,
  input: { name?: string; description?: string },
): Promise<WorkspaceGroup> {
  const group = await findGroup(ws, identifier);
  const name = input.name === undefined ? group.name : groupName(input.name);
  const description = input.description === undefined ? group.description : input.description.trim() || null;
  const [written = []] = await ws.db.run([
    {
      sql: `UPDATE groups SET name = ?3, description = ?4
WHERE id = ?1 AND organization_id = ?2
  AND NOT EXISTS (SELECT 1 FROM groups WHERE organization_id = ?2 AND lower(name) = lower(?3) AND id != ?1)
RETURNING id`,
      params: [group.id, ws.organization.id, name, description],
    },
  ]);
  if (written.length === 0) throw groupNameTaken(name);
  return { ...group, name, description };
}

/** Delete a group (GroupService.deleteGroup): what it granted ends with it. */
export async function deleteGroup(ws: Workspace, identifier: string): Promise<WorkspaceGroup> {
  const group = await findGroup(ws, identifier);
  const params = [group.id, ws.organization.id];
  await ws.db.run([
    { sql: "DELETE FROM group_app_access WHERE group_id = ?1 AND organization_id = ?2", params },
    { sql: "DELETE FROM group_members WHERE group_id = ?1 AND organization_id = ?2", params },
    { sql: "DELETE FROM groups WHERE id = ?1 AND organization_id = ?2", params },
  ]);
  return group;
}

/** A member, and whether they are in the group (GroupRepository.listMembersWithState). */
export type GroupMemberState = WorkspaceMember & { inGroup: boolean };

export async function groupMembers(
  ws: Workspace,
  group: WorkspaceGroup,
): Promise<GroupMemberState[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${MEMBER_COLUMNS}, (gm.user_id IS NOT NULL) AS in_group
FROM members m JOIN users u ON u.id = m.user_id
LEFT JOIN group_members gm ON gm.group_id = ?2 AND gm.user_id = u.id
WHERE m.organization_id = ?1 ORDER BY u.email`,
      params: [ws.organization.id, group.id],
    },
  ]);
  return rows.map((row) => ({ ...toMember(row, ws.now), inGroup: Number(row["in_group"]) === 1 }));
}

/** How a list of members or apps changes: the whole list, or what joins and leaves. */
interface ListChange {
  set?: readonly string[];
  add?: readonly string[];
  remove?: readonly string[];
}

/** Which ids join and leave, from the current ids and the change asked for. */
function planChange(current: readonly string[], wanted: { set?: readonly string[]; add?: readonly string[]; remove?: readonly string[] }): { add: string[]; remove: string[] } {
  const now = new Set(current);
  if (wanted.set) {
    const target = new Set(wanted.set);
    return {
      add: [...target].filter((id) => !now.has(id)),
      remove: [...now].filter((id) => !target.has(id)),
    };
  }
  const add = [...new Set(wanted.add ?? [])].filter((id) => !now.has(id));
  const remove = [...new Set(wanted.remove ?? [])].filter((id) => now.has(id));
  return { add, remove };
}

/** Each identifier resolved to a member, in order, once each. */
async function resolveMembers(ws: Workspace, identifiers: readonly string[]): Promise<WorkspaceMember[]> {
  const members: WorkspaceMember[] = [];
  for (const identifier of identifiers) {
    const member = await findMember(ws, identifier);
    if (!members.some((known) => known.id === member.id)) members.push(member);
  }
  return members;
}

/** Each identifier resolved to one of the organization's own apps, once each. */
async function resolveApps(ws: Workspace, identifiers: readonly string[]): Promise<WorkspaceApp[]> {
  const apps: WorkspaceApp[] = [];
  for (const identifier of identifiers) {
    const app = await findApp(ws, identifier);
    if (!apps.some((known) => known.id === app.id)) apps.push(app);
  }
  return apps;
}

/** The change applied, and the members as they are after it. */
interface GroupMembersChange {
  added: WorkspaceMember[];
  removed: WorkspaceMember[];
  members: GroupMemberState[];
}

/**
 * Change who is in a group (GroupService.setGroupMembers): the whole list,
 * or who joins and leaves. Only members of the organization, which the
 * insert checks again.
 */
export async function setGroupMembers(
  ws: Workspace,
  group: WorkspaceGroup,
  change: ListChange,
): Promise<GroupMembersChange> {
  const [set, add, remove] = await Promise.all([
    change.set ? resolveMembers(ws, change.set) : undefined,
    resolveMembers(ws, change.add ?? []),
    resolveMembers(ws, change.remove ?? []),
  ]);
  const before = await groupMembers(ws, group);
  const current = before.filter((member) => member.inGroup).map((member) => member.id);
  const plan = planChange(current, {
    set: set?.map((member) => member.id),
    add: add.map((member) => member.id),
    remove: remove.map((member) => member.id),
  });
  const byId = new Map(before.map((member) => [member.id, member]));
  await ws.db.run([
    ...chunks(plan.remove, IDS_PER_STATEMENT).map((ids) => ({
      sql: `DELETE FROM group_members WHERE group_id = ? AND organization_id = ? AND user_id IN (${ids.map(() => "?").join(", ")})`,
      params: [group.id, ws.organization.id, ...ids],
    })),
    ...plan.add.map((userId) => ({
      sql: `INSERT INTO group_members (group_id, user_id, organization_id, added_at, added_by)
SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM members WHERE user_id = ?2 AND organization_id = ?3)
ON CONFLICT DO NOTHING`,
      params: [group.id, userId, ws.organization.id, ws.now, ws.operator.userId],
    })),
  ]);
  return {
    added: plan.add.map((id) => byId.get(id)!),
    removed: plan.remove.map((id) => byId.get(id)!),
    members: await groupMembers(ws, group),
  };
}

/** One of the organization's own apps, and whether the group opens it (GroupRepository.listAppsWithState). */
export type GroupAppState = WorkspaceApp & { granted: boolean };

export async function groupApps(ws: Workspace, group: WorkspaceGroup): Promise<GroupAppState[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${APP_COLUMNS}, (ga.group_id IS NOT NULL) AS granted FROM apps a
LEFT JOIN group_app_access ga ON ga.group_id = ?2 AND ga.app_row_id = a.id
WHERE a.organization_id = ?1 AND a.scope != 'shared' AND a.status != '${DELETED_APP_STATUS}' ORDER BY a.name`,
      params: [ws.organization.id, group.id],
    },
  ]);
  return rows.map((row) => ({ ...toApp(row), granted: Number(row["granted"]) === 1 }));
}

function sharedAppAccess(app: WorkspaceApp): EveryAppError {
  return new EveryAppError(
    "SHARED_APP_ACCESS",
    `${app.appSlug} is a shared app: every member of every organization can open it, so its access can't be changed`,
  );
}

interface GroupAppsChange {
  added: WorkspaceApp[];
  removed: WorkspaceApp[];
  apps: GroupAppState[];
}

/** Change which apps a group opens (GroupService.setGroupApps): the organization's own only. */
export async function setGroupApps(
  ws: Workspace,
  group: WorkspaceGroup,
  change: ListChange,
): Promise<GroupAppsChange> {
  const [set, add, remove] = await Promise.all([
    change.set ? resolveApps(ws, change.set) : undefined,
    resolveApps(ws, change.add ?? []),
    resolveApps(ws, change.remove ?? []),
  ]);
  for (const app of [...(set ?? []), ...add]) if (app.scope === "shared") throw sharedAppAccess(app);
  const before = await groupApps(ws, group);
  const plan = planChange(
    before.filter((app) => app.granted).map((app) => app.id),
    { set: set?.map((app) => app.id), add: add.map((app) => app.id), remove: remove.map((app) => app.id) },
  );
  const byId = new Map(before.map((app) => [app.id, app]));
  await ws.db.run([
    ...chunks(plan.remove, IDS_PER_STATEMENT).map((ids) => ({
      sql: `DELETE FROM group_app_access WHERE group_id = ? AND organization_id = ? AND app_row_id IN (${ids.map(() => "?").join(", ")})`,
      params: [group.id, ws.organization.id, ...ids],
    })),
    ...plan.add.map((appRowId) => ({
      sql: `INSERT INTO group_app_access (group_id, app_row_id, organization_id, granted_at, granted_by)
SELECT ?1, ?2, ?3, ?4, ?5
WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?2 AND organization_id = ?3 AND scope != 'shared' AND status != '${DELETED_APP_STATUS}')
ON CONFLICT DO NOTHING`,
      params: [group.id, appRowId, ws.organization.id, ws.now, ws.operator.userId],
    })),
  ]);
  return {
    added: plan.add.map((id) => byId.get(id)!),
    removed: plan.remove.map((id) => byId.get(id)!),
    apps: await groupApps(ws, group),
  };
}

/** Every app of the organization (AppRepository.findAllWithAccessCounts), tombstones aside, by name. */
export async function listApps(ws: Workspace): Promise<WorkspaceApp[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps a WHERE a.organization_id = ?1 AND a.status != '${DELETED_APP_STATUS}' ORDER BY a.name`,
      params: [ws.organization.id],
    },
  ]);
  return rows.map(toApp);
}

/** What `app set` changes; what isn't given stays. */
interface AppUpdate {
  name?: string;
  description?: string;
  everyone?: boolean;
}

/** An app's name as the Gateway takes one (schemas/app.ts): trimmed, 1 to 255 characters. */
export function appName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > APP_NAME_MAX) {
    throw new EveryAppError(
      "APP_NAME_INVALID",
      `An app's name is 1 to ${APP_NAME_MAX} characters${trimmed ? ` (${trimmed.length} given)` : ", not empty"}`,
      { fix: "give --name the name the app library should show, or leave --name off" },
    );
  }
  return trimmed;
}

/**
 * Update an app's catalog entry (AppService.update). Turning "available to
 * everyone" on grants every current member now (and every future member on
 * joining); turning it off keeps existing access. A shared app opens for
 * everyone already and is never an organization's default.
 */
export async function updateApp(
  ws: Workspace,
  identifier: string,
  update: AppUpdate,
): Promise<{ app: WorkspaceApp; granted: number }> {
  const app = await findApp(ws, identifier);
  if (update.name === undefined && update.description === undefined && update.everyone === undefined) {
    throw new EveryAppError("NOTHING_TO_SET", "Nothing to set: give --name, --description or --everyone on|off");
  }
  if (app.scope === "shared" && update.everyone) throw sharedAppAccess(app);
  const name = update.name === undefined ? app.name : appName(update.name);
  const description = update.description === undefined ? app.description : update.description.trim();
  const everyone = update.everyone ?? app.everyone;
  const grants: D1Statement[] = [];
  if (everyone && !app.everyone) {
    const [members = []] = await ws.db.run([
      { sql: "SELECT user_id FROM members WHERE organization_id = ?", params: [ws.organization.id] },
    ]);
    for (const batch of chunks(members, ROWS_PER_INSERT)) {
      grants.push({
        sql: `INSERT INTO user_app_access (id, user_id, app_row_id, organization_id, granted_by) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING RETURNING id`,
        params: batch.flatMap((member) => [randomUUID(), String(member["user_id"]), app.id, ws.organization.id, ws.operator.userId]),
      });
    }
  }
  const [, ...granted] = await ws.db.run([
    {
      sql: `UPDATE apps SET name = ?3, description = ?4, is_default = ?5, updated_at = ?6
WHERE id = ?1 AND organization_id = ?2 AND status != '${DELETED_APP_STATUS}'`,
      params: [app.id, ws.organization.id, name, description, everyone ? 1 : 0, ws.now],
    },
    ...grants,
  ]);
  return { app: await findApp(ws, app.id), granted: granted.reduce((count, rows) => count + rows.length, 0) };
}

/** A member and their access to one app (AppAccessService.getAccessStateForApp). */
export type AppAccessState = WorkspaceMember & {
  /** A direct grant, which `app access --add/--remove/--set` edits. */
  direct: boolean;
  /** The groups that open it for them, by name. */
  viaGroups: string[];
};

export async function appAccess(ws: Workspace, app: WorkspaceApp): Promise<AppAccessState[]> {
  if (app.scope === "shared") throw sharedAppAccess(app);
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT ${MEMBER_COLUMNS},
  (ua.id IS NOT NULL) AS direct,
  (SELECT group_concat(g.name, char(31)) FROM group_app_access ga
     JOIN group_members gm ON gm.group_id = ga.group_id AND gm.user_id = u.id
     JOIN groups g ON g.id = ga.group_id
   WHERE ga.app_row_id = ?2 AND ga.organization_id = ?1) AS via_groups
FROM members m JOIN users u ON u.id = m.user_id
LEFT JOIN user_app_access ua ON ua.app_row_id = ?2 AND ua.organization_id = ?1 AND ua.user_id = u.id
WHERE m.organization_id = ?1 ORDER BY u.email`,
      params: [ws.organization.id, app.id],
    },
  ]);
  return rows.map((row) => ({
    ...toMember(row, ws.now),
    direct: Number(row["direct"]) === 1,
    viaGroups: text(row["via_groups"])?.split("\u001f").sort() ?? [],
  }));
}

interface AppAccessChange {
  granted: WorkspaceMember[];
  revoked: WorkspaceMember[];
  users: AppAccessState[];
}

/**
 * Change who holds a direct grant to an app (AppAccessService.updateAccessForApp):
 * the whole list, or who is granted and revoked. What a group grants is
 * never touched; only members of the organization, which the insert checks.
 */
export async function setAppAccess(
  ws: Workspace,
  app: WorkspaceApp,
  change: ListChange,
): Promise<AppAccessChange> {
  if (app.scope === "shared") throw sharedAppAccess(app);
  const [set, add, remove] = await Promise.all([
    change.set ? resolveMembers(ws, change.set) : undefined,
    resolveMembers(ws, change.add ?? []),
    resolveMembers(ws, change.remove ?? []),
  ]);
  const before = await appAccess(ws, app);
  const plan = planChange(
    before.filter((user) => user.direct).map((user) => user.id),
    { set: set?.map((member) => member.id), add: add.map((member) => member.id), remove: remove.map((member) => member.id) },
  );
  const byId = new Map(before.map((user) => [user.id, user]));
  await ws.db.run([
    ...chunks(plan.remove, IDS_PER_STATEMENT).map((ids) => ({
      sql: `DELETE FROM user_app_access WHERE app_row_id = ? AND organization_id = ? AND user_id IN (${ids.map(() => "?").join(", ")})`,
      params: [app.id, ws.organization.id, ...ids],
    })),
    ...plan.add.map((userId) => ({
      sql: `INSERT INTO user_app_access (id, user_id, app_row_id, organization_id, granted_at, granted_by)
SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM members WHERE user_id = ?2 AND organization_id = ?4)
ON CONFLICT DO NOTHING`,
      params: [randomUUID(), userId, app.id, ws.organization.id, ws.now, ws.operator.userId],
    })),
  ]);
  return {
    granted: plan.add.map((id) => byId.get(id)!),
    revoked: plan.remove.map((id) => byId.get(id)!),
    users: await appAccess(ws, app),
  };
}

/** Where a binding cap came from: the app's own row, or the organization's default (server/app-cap.ts). */
type CapSource = "app" | "default";

/** The cap that binds (organization, app) this month, and where it came from. */
interface EffectiveCap {
  cap: number | null;
  source: CapSource | null;
}

/**
 * The Gateway's rule (server/app-cap.ts `effectiveMonthlyCap`): a cap on
 * the row wins (even next to `unlimited`, which fails safe); then
 * `unlimited` says none; then the default; then none.
 */
function effectiveMonthlyCap(input: {
  appCap: number | null;
  unlimited: boolean;
  defaultCap: number | null;
}): EffectiveCap {
  if (input.appCap !== null) return { cap: input.appCap, source: "app" };
  if (input.unlimited) return { cap: null, source: null };
  if (input.defaultCap !== null) return { cap: input.defaultCap, source: "default" };
  return { cap: null, source: null };
}

/**
 * Set, raised or removed is `cap.raised` (AppCapService's rule): what a
 * person waiting on a paused app wants to hear. A lowered cap is not an
 * event.
 */
const raised = (cap: number | null, previousCap: number | null): boolean =>
  cap === null ? previousCap !== null : previousCap === null || cap > previousCap;

const defaultCapsRows = new WeakMap<D1Database, Promise<boolean>>();

/**
 * Whether the Gateway's D1 has the default cap's rows (migration 0014,
 * `caps_defaults`, 2026-10-25: the `org_settings` table and
 * `org_app_settings.unlimited`). A Gateway from before it has neither
 * until `update` runs its migrations. Asked of each database once, like
 * `hasSecretNamesColumn`.
 */
function hasDefaultCaps(db: D1Database): Promise<boolean> {
  let known = defaultCapsRows.get(db);
  if (!known) {
    known = db
      .run([{ sql: "PRAGMA table_info(org_settings)" }, { sql: "PRAGMA table_info(org_app_settings)" }])
      .then(
        ([settings = [], appSettings = []]) =>
          settings.length > 0 && appSettings.some((row) => row["name"] === "unlimited"),
      );
    defaultCapsRows.set(db, known);
  }
  return known;
}

/** Refuse what needs the default cap's rows on a Gateway from before them. */
async function requireDefaultCaps(db: D1Database): Promise<void> {
  if (await hasDefaultCaps(db)) return;
  throw new EveryAppError(
    "GATEWAY_PREDATES_DEFAULT_CAPS",
    "The Gateway predates default caps\nIts database has no workspace default cap and no no-cap override until the Gateway is updated to a release that has them.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

const validCap = (cap: number | null): boolean =>
  cap === null || (Number.isInteger(cap) && cap >= 1 && cap <= MONTHLY_CALL_CAP_MAX);

const invalidCap = (): EveryAppError =>
  new EveryAppError(
    "INVALID_CAP",
    `A monthly cap is a whole number from 1 to ${MONTHLY_CALL_CAP_MAX.toLocaleString("en-US")}, or off`,
  );

/** What `setMonthlyCap` answers: the app's row before and after, and what binds it. */
interface AppCapChange {
  app: WorkspaceApp;
  /** The app's own cap now, or null. */
  cap: number | null;
  /** The app has no cap whatever the default (the row's `unlimited`). */
  unlimited: boolean;
  /** The app's own cap before, or null. */
  was: number | null;
  wasUnlimited: boolean;
  /** The cap that binds the app now, and where it comes from. */
  effective: EffectiveCap;
  /** The cap that bound it before. */
  before: EffectiveCap;
  /** The Cap alerts subscription's id when this write made it, else null. */
  capAlertsId: string | null;
}

/**
 * Set the organization's cap on an app's provider calls (a whole number of
 * calls per UTC month), say the app has none whatever the default
 * (`unlimited`), or neither (`off`: the row goes, so the default applies,
 * and without one the app is unlimited), as AppCapService.setMonthlyCap
 * does. The row holds exactly one of a cap or `unlimited`, both columns
 * written in one statement (the Gateway reads "a cap wins", so a row with
 * both would be capped). The app must be one the organization calls: its
 * own, or a shared one. In the write's own batch, as the Gateway does: a
 * number set makes the organization's built-in Cap alerts subscription
 * when it has none (`capAlertsId`, the new row's id, else null), and
 * `cap.raised` is queued when the cap that binds the app ends higher or
 * gone, judged on the effective cap before and after (its own, else the
 * default): a cap set under the default is no raise, `unlimited` under a
 * default is a removal, `off` under a default raises to it. Neither on a
 * Gateway from before the event tables. On a Gateway from before the
 * default cap (migration 0014) a number and `off` still write the cap
 * alone; `unlimited` is refused (GATEWAY_PREDATES_DEFAULT_CAPS).
 */
export async function setMonthlyCap(
  ws: Workspace,
  identifier: string,
  cap: number | null,
  options: { unlimited?: boolean } = {},
): Promise<AppCapChange> {
  const unlimited = options.unlimited ?? false;
  const app = await findApp(ws, identifier, { callable: true });
  if (!validCap(cap)) throw invalidCap();
  if (cap !== null && unlimited) {
    throw new EveryAppError("INVALID_CAP", "An app has a cap or no cap, not both\nGive a number, off, or --unlimited.");
  }
  const modern = await hasDefaultCaps(ws.db);
  if (unlimited) await requireDefaultCaps(ws.db);
  const org = ws.organization.id;
  const [rows = [], defaults = []] = await ws.db.run([
    {
      sql: `SELECT monthly_call_cap${modern ? ", unlimited" : ""} FROM org_app_settings WHERE organization_id = ? AND app_row_id = ?`,
      params: [org, app.id],
    },
    ...(modern
      ? [{ sql: "SELECT default_monthly_call_cap AS cap FROM org_settings WHERE organization_id = ?", params: [org] }]
      : []),
  ]);
  const was = rows[0]?.["monthly_call_cap"] == null ? null : Number(rows[0]["monthly_call_cap"]);
  const wasUnlimited = Number(rows[0]?.["unlimited"] ?? 0) === 1;
  const defaultCap = defaults[0]?.["cap"] == null ? null : Number(defaults[0]["cap"]);
  const before = effectiveMonthlyCap({ appCap: was, unlimited: wasUnlimited, defaultCap });
  const effective = effectiveMonthlyCap({ appCap: cap, unlimited, defaultCap });
  const capAlerts =
    cap === null ? null : await capAlertsStatement(ws.db, { organizationId: org, deployer: ws.operator, now: ws.now });
  const event = raised(effective.cap, before.cap)
    ? await queueEventFromCli(ws.db, {
        organizationId: org,
        type: "cap.raised",
        actor: operatorActor(ws.operator),
        data: {
          app: { id: app.appSlug, rowId: app.id, name: app.name },
          cap: effective.cap,
          previousCap: before.cap,
          source: "app",
        },
        appRowId: app.id,
        now: ws.now,
      })
    : [];
  const write: D1Statement =
    cap === null && !unlimited
      ? { sql: "DELETE FROM org_app_settings WHERE organization_id = ? AND app_row_id = ?", params: [org, app.id] }
      : modern
        ? {
            // Both columns in the one statement: a cap or unlimited, never both.
            sql: `INSERT INTO org_app_settings (organization_id, app_row_id, monthly_call_cap, unlimited, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (organization_id, app_row_id) DO UPDATE SET monthly_call_cap = ?3, unlimited = ?4, updated_at = ?5, updated_by = ?6`,
            params: [org, app.id, cap, unlimited ? 1 : 0, ws.now, ws.operator.userId],
          }
        : {
            sql: `INSERT INTO org_app_settings (organization_id, app_row_id, monthly_call_cap, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (organization_id, app_row_id) DO UPDATE SET monthly_call_cap = ?3, updated_at = ?4, updated_by = ?5`,
            params: [org, app.id, cap, ws.now, ws.operator.userId],
          };
  const results = await ws.db.run([write, ...(capAlerts ? [capAlerts] : []), ...event]);
  const capAlertsId = capAlerts ? text(results[1]?.[0]?.["id"]) : null;
  return { app, cap, unlimited, was, wasUnlimited, effective, before, capAlertsId };
}

/** What `setDefaultMonthlyCap` answers. */
interface DefaultCapChange {
  cap: number | null;
  was: number | null;
  /** The Cap alerts subscription's id when this write made it, else null. */
  capAlertsId: string | null;
}

/**
 * Set or clear the organization's default cap
 * (AppCapService.setDefaultMonthlyCap): what binds every app without a
 * cap or `unlimited` of its own. `off` deletes the `org_settings` row, as
 * the Gateway does (the table holds nothing else yet); `updated_by` is
 * the operator's Gateway user, or null for an API token. In the write's
 * own batch: a number set makes the Cap alerts subscription when the
 * organization has none, and the default first set, raised or removed
 * queues `cap.raised` with no app and `source: "default"` (a lowered one
 * is not an event). Refused on a Gateway from before migration 0014
 * (GATEWAY_PREDATES_DEFAULT_CAPS).
 */
export async function setDefaultMonthlyCap(ws: Workspace, cap: number | null): Promise<DefaultCapChange> {
  if (!validCap(cap)) throw invalidCap();
  await requireDefaultCaps(ws.db);
  const org = ws.organization.id;
  const [rows = []] = await ws.db.run([
    { sql: "SELECT default_monthly_call_cap AS cap FROM org_settings WHERE organization_id = ?", params: [org] },
  ]);
  const was = rows[0]?.["cap"] == null ? null : Number(rows[0]["cap"]);
  const capAlerts =
    cap === null ? null : await capAlertsStatement(ws.db, { organizationId: org, deployer: ws.operator, now: ws.now });
  const event = raised(cap, was)
    ? await queueEventFromCli(ws.db, {
        organizationId: org,
        type: "cap.raised",
        actor: operatorActor(ws.operator),
        data: { app: null, cap, previousCap: was, source: "default" },
        now: ws.now,
      })
    : [];
  // The row also holds the default model provider (ai_default, migration
  // 0017): clearing the cap keeps the row while that is set, and the row
  // goes only when it holds nothing else.
  const write =
    cap === null
      ? (await hasAiDefault(ws.db))
        ? [
            {
              sql: "UPDATE org_settings SET default_monthly_call_cap = NULL, updated_at = ?, updated_by = ? WHERE organization_id = ?",
              params: [ws.now, ws.operator.userId, org],
            },
            {
              sql: "DELETE FROM org_settings WHERE organization_id = ? AND ai_default IS NULL AND default_monthly_call_cap IS NULL",
              params: [org],
            },
          ]
        : [{ sql: "DELETE FROM org_settings WHERE organization_id = ?", params: [org] }]
      : [
          {
            sql: `INSERT INTO org_settings (organization_id, default_monthly_call_cap, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (organization_id) DO UPDATE SET default_monthly_call_cap = ?2, updated_at = ?3, updated_by = ?4`,
            params: [org, cap, ws.now, ws.operator.userId],
          },
        ];
  const results = await ws.db.run([...write, ...(capAlerts ? [capAlerts] : []), ...event]);
  const capAlertsId = capAlerts ? text(results[write.length]?.[0]?.["id"]) : null;
  return { cap, was, capAlertsId };
}

/** The provider totals every usage row carries (UsageTotals). */
interface UsageTotals {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in millionths of a US dollar. */
  costMicros: number;
}

interface UsageAppRow extends UsageTotals {
  appRowId: string;
  appSlug: string | null;
  name: string | null;
  toolCalls: number;
  /** The organization's own cap on the app, or null; always null on an app that is not callable. */
  monthlyCallCap: number | null;
  /** The app has no cap even though the organization set a default. */
  capUnlimited: boolean;
  /** The cap that binds the app this month (its own, else the default unless unlimited), and which. */
  effectiveMonthlyCallCap: number | null;
  capSource: CapSource | null;
  /** The app has reached its effective cap in the current UTC month; always false for a past month. */
  paused: boolean;
  callable: boolean;
}

interface UsageMemberRow extends UsageTotals {
  /** '' for the apps' own calls (background work). */
  userId: string;
  name: string | null;
  email: string | null;
  toolCalls: number;
}

interface UsageTargetRow extends UsageTotals {
  kind: string;
  target: string;
}

interface UsageSummary {
  month: string;
  /** The organization's default cap on every app without its own, or null. */
  defaultMonthlyCallCap: number | null;
  byApp: UsageAppRow[];
  byMember: UsageMemberRow[];
  byTarget: UsageTargetRow[];
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** UTC "YYYY-MM" of a time. */
export function utcMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, months: number): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return utcMonth(new Date(Date.UTC(year, index - 1 + months, 1)));
}

const TOTALS = `COALESCE(SUM(d.calls), 0) AS calls, COALESCE(SUM(d.failures), 0) AS failures,
  COALESCE(SUM(d.input_tokens), 0) AS input_tokens, COALESCE(SUM(d.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(d.cost_micros), 0) AS cost_micros`;

const totalsOf = (row: D1Row): UsageTotals => ({
  calls: number(row["calls"]),
  failures: number(row["failures"]),
  inputTokens: number(row["input_tokens"]),
  outputTokens: number(row["output_tokens"]),
  costMicros: number(row["cost_micros"]),
});

const NONE: UsageTotals = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };

/** An app row's cap fields before the organization's row on it is read. */
const UNCAPPED: Pick<
  UsageAppRow,
  "monthlyCallCap" | "capUnlimited" | "effectiveMonthlyCallCap" | "capSource" | "paused"
> = { monthlyCallCap: null, capUnlimited: false, effectiveMonthlyCallCap: null, capSource: null, paused: false };

/**
 * What the organization's apps spent in a UTC month, three ways
 * (UsageRepository.summarize): per app (every callable app listed, with
 * its own cap, the cap that binds it and where it comes from, whether it
 * is paused this month, zeros in a month it made no call), per member (a
 * '' row for the apps' own calls; a former member by id) and per provider
 * or capability, with the organization's default cap. Allowed MCP tool
 * calls come from the audit trail. Refused on a Gateway from before the
 * default cap's rows (GATEWAY_PREDATES_DEFAULT_CAPS).
 */
export async function usage(ws: Workspace, month: string): Promise<UsageSummary> {
  if (!MONTH.test(month)) throw new EveryAppError("INVALID_MONTH", `--month ${month} isn't a month: use YYYY-MM`);
  await requireDefaultCaps(ws.db);
  const org = ws.organization.id;
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const inMonth = "d.organization_id = ?1 AND d.day >= ?2 AND d.day < ?3";
  const callsInMonth = "c.organization_id = ?1 AND c.decision = 'allowed' AND c.created_at >= ?2 AND c.created_at < ?3";
  const [
    byApp = [],
    byMember = [],
    byTarget = [],
    toolsByApp = [],
    toolsByMember = [],
    callable = [],
    defaults = [],
  ] = await ws.db.run([
      {
        sql: `SELECT d.app_row_id, a.name, a.app_slug, ${TOTALS} FROM usage_daily d LEFT JOIN apps a ON a.id = d.app_row_id
WHERE ${inMonth} GROUP BY d.app_row_id, a.name, a.app_slug`,
        params: [org, from, to],
      },
      {
        sql: `SELECT d.user_id, u.name, u.email, ${TOTALS} FROM usage_daily d
LEFT JOIN members m ON m.user_id = d.user_id AND m.organization_id = d.organization_id
LEFT JOIN users u ON u.id = m.user_id
WHERE ${inMonth} GROUP BY d.user_id, u.name, u.email`,
        params: [org, from, to],
      },
      {
        sql: `SELECT d.kind, d.target, ${TOTALS} FROM usage_daily d WHERE ${inMonth} GROUP BY d.kind, d.target`,
        params: [org, from, to],
      },
      {
        sql: `SELECT c.app_row_id, a.name, a.app_slug, COUNT(*) AS tool_calls FROM mcp_tool_calls c
LEFT JOIN apps a ON a.id = c.app_row_id WHERE ${callsInMonth} GROUP BY c.app_row_id, a.name, a.app_slug`,
        params: [org, fromMs, toMs],
      },
      {
        sql: `SELECT c.user_id, u.name, u.email, COUNT(*) AS tool_calls FROM mcp_tool_calls c
LEFT JOIN members m ON m.user_id = c.user_id AND m.organization_id = c.organization_id
LEFT JOIN users u ON u.id = m.user_id
WHERE ${callsInMonth} GROUP BY c.user_id, u.name, u.email`,
        params: [org, fromMs, toMs],
      },
      {
        sql: `SELECT a.id AS app_row_id, a.name, a.app_slug, s.monthly_call_cap, s.unlimited FROM apps a
LEFT JOIN org_app_settings s ON s.app_row_id = a.id AND s.organization_id = ?1
WHERE (a.organization_id = ?1 OR a.scope = 'shared') AND a.status != '${DELETED_APP_STATUS}'`,
        params: [org],
      },
      { sql: "SELECT default_monthly_call_cap AS cap FROM org_settings WHERE organization_id = ?", params: [org] },
    ]);
  const defaultMonthlyCallCap = defaults[0]?.["cap"] == null ? null : Number(defaults[0]["cap"]);
  const apps = new Map<string, UsageAppRow>();
  for (const row of byApp) {
    apps.set(String(row["app_row_id"]), {
      appRowId: String(row["app_row_id"]),
      appSlug: text(row["app_slug"]),
      name: text(row["name"]),
      ...totalsOf(row),
      toolCalls: 0,
      ...UNCAPPED,
      callable: false,
    });
  }
  for (const row of toolsByApp) {
    const id = text(row["app_row_id"]);
    if (!id) continue;
    const existing = apps.get(id);
    if (existing) existing.toolCalls = number(row["tool_calls"]);
    else {
      apps.set(id, {
        appRowId: id,
        appSlug: text(row["app_slug"]),
        name: text(row["name"]),
        ...NONE,
        toolCalls: number(row["tool_calls"]),
        ...UNCAPPED,
        callable: false,
      });
    }
  }
  // Paused is this month's state only: a past month's count against
  // today's cap says nothing.
  const current = month === utcMonth(new Date(ws.now));
  for (const row of callable) {
    const id = String(row["app_row_id"]);
    const cap = row["monthly_call_cap"] == null ? null : Number(row["monthly_call_cap"]);
    const capUnlimited = Number(row["unlimited"] ?? 0) === 1;
    const effective = effectiveMonthlyCap({ appCap: cap, unlimited: capUnlimited, defaultCap: defaultMonthlyCallCap });
    const existing = apps.get(id) ?? {
      appRowId: id,
      appSlug: text(row["app_slug"]),
      name: text(row["name"]),
      ...NONE,
      toolCalls: 0,
      ...UNCAPPED,
      callable: true,
    };
    existing.callable = true;
    existing.monthlyCallCap = cap;
    existing.capUnlimited = capUnlimited;
    existing.effectiveMonthlyCallCap = effective.cap;
    existing.capSource = effective.source;
    existing.paused = current && effective.cap !== null && existing.calls >= effective.cap;
    apps.set(id, existing);
  }
  const members = new Map<string, UsageMemberRow>();
  for (const row of byMember) {
    members.set(String(row["user_id"]), {
      userId: String(row["user_id"]),
      name: text(row["name"]),
      email: text(row["email"]),
      ...totalsOf(row),
      toolCalls: 0,
    });
  }
  for (const row of toolsByMember) {
    const id = String(row["user_id"]);
    const existing = members.get(id);
    if (existing) existing.toolCalls = number(row["tool_calls"]);
    else {
      members.set(id, {
        userId: id,
        name: text(row["name"]),
        email: text(row["email"]),
        ...NONE,
        toolCalls: number(row["tool_calls"]),
      });
    }
  }
  const byCalls = <T extends { calls: number; toolCalls: number }>(a: T, b: T) =>
    b.calls - a.calls || b.toolCalls - a.toolCalls;
  return {
    month,
    defaultMonthlyCallCap,
    byApp: [...apps.values()].sort(
      (a, b) => byCalls(a, b) || (a.name ?? a.appRowId).localeCompare(b.name ?? b.appRowId),
    ),
    byMember: [...members.values()].sort(byCalls),
    byTarget: byTarget
      .map((row) => ({ kind: String(row["kind"]), target: String(row["target"]), ...totalsOf(row) }))
      .sort((a, b) => b.calls - a.calls),
  };
}

/** Where a page of tool calls continues: its last row's time and id. */
interface ActivityCursor {
  createdAt: number;
  id: string;
}

interface ActivityFilters {
  /** Rows per page, clamped to 1..200 like the Gateway. */
  limit?: number;
  before?: ActivityCursor;
  appRowId?: string;
  userId?: string;
  decision?: "allowed" | "blocked";
  risk?: string;
  /** Milliseconds: rows recorded at or after this time only. */
  since?: number;
}

/** One MCP tool call as Admin → Activity lists it: never the arguments or the result. */
interface ActivityRow {
  id: string;
  createdAt: number;
  user: { id: string; name: string | null; email: string | null };
  credential: { kind: string; clientName: string | null; clientInfo: string | null };
  app: { rowId: string | null; slug: string | null; name: string | null; removed: boolean };
  tool: { name: string; risk: string | null; via: string | null };
  decision: "allowed" | "blocked";
  reason: string | null;
  outcome: string;
  durationMs: number | null;
  resultBytes: number | null;
}

/** The most rows one page carries (McpToolCallRepository.TOOL_CALL_PAGE_MAX). */
export const ACTIVITY_PAGE_MAX = 200;

/**
 * One page of the organization's tool calls, newest first
 * (McpToolCallRepository.listForOrganization): each app's current name,
 * each caller's name as a member of this organization (a person who has
 * since left shows by id). Keyset on (created_at, id), so a page is stable.
 */
export async function activity(
  ws: Workspace,
  filters: ActivityFilters,
): Promise<{ calls: ActivityRow[]; nextBefore: ActivityCursor | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(filters.limit ?? 50) || 1), ACTIVITY_PAGE_MAX);
  const conditions = ["c.organization_id = ?"];
  const params: Array<string | number> = [ws.organization.id];
  if (filters.before) {
    conditions.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
    params.push(filters.before.createdAt, filters.before.createdAt, filters.before.id);
  }
  for (const [column, value] of [
    ["c.app_row_id", filters.appRowId],
    ["c.user_id", filters.userId],
    ["c.decision", filters.decision],
    ["c.risk", filters.risk],
  ] as const) {
    if (value === undefined) continue;
    conditions.push(`${column} = ?`);
    params.push(value);
  }
  if (filters.since !== undefined) {
    conditions.push("c.created_at >= ?");
    params.push(filters.since);
  }
  params.push(limit + 1);
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT c.id, c.created_at, c.user_id, u.name AS user_name, u.email AS user_email,
  c.credential_kind, c.client_name, c.client_info, c.app_row_id, c.app_slug, a.name AS app_name, a.status AS app_status,
  c.tool_name, c.via, c.risk, c.decision, c.reason, c.outcome, c.duration_ms, c.result_bytes
FROM mcp_tool_calls c
LEFT JOIN apps a ON a.id = c.app_row_id
LEFT JOIN members m ON m.user_id = c.user_id AND m.organization_id = c.organization_id
LEFT JOIN users u ON u.id = m.user_id
WHERE ${conditions.join(" AND ")}
ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
      params,
    },
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    calls: page.map((row) => {
      const appRowId = text(row["app_row_id"]);
      const appStatus = text(row["app_status"]);
      return {
        id: String(row["id"]),
        createdAt: number(row["created_at"]),
        user: { id: String(row["user_id"]), name: text(row["user_name"]), email: text(row["user_email"]) },
        credential: {
          kind: String(row["credential_kind"]),
          clientName: text(row["client_name"]),
          clientInfo: text(row["client_info"]),
        },
        app: {
          rowId: appRowId,
          slug: text(row["app_slug"]),
          name: text(row["app_name"]),
          removed: appRowId !== null && (appStatus === null || appStatus === DELETED_APP_STATUS),
        },
        tool: { name: String(row["tool_name"]), risk: text(row["risk"]), via: text(row["via"]) },
        decision: row["decision"] === "allowed" ? "allowed" : "blocked",
        reason: text(row["reason"]),
        outcome: String(row["outcome"]),
        durationMs: row["duration_ms"] == null ? null : Number(row["duration_ms"]),
        resultBytes: row["result_bytes"] == null ? null : Number(row["result_bytes"]),
      };
    }),
    nextBefore:
      rows.length > limit && last ? { createdAt: number(last["created_at"]), id: String(last["id"]) } : null,
  };
}

/** Where a page of the audit log continues: its last row's time and id. */
interface AuditCursor {
  time: number;
  id: string;
}

/** A type, a prefix with `.*`, or `*`: what `--type` accepts (the Gateway's AUDIT_TYPE_FILTER_PATTERN). */
export const AUDIT_TYPE_FILTER = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;
export const AUDIT_TYPE_MAX = 80;

interface AuditFilters {
  /** Rows per page, clamped to 1..200 like the Gateway. */
  limit?: number;
  before?: AuditCursor;
  /** `actor_id`: a user id, a credential id, an app id, an operator's id. */
  actorId?: string;
  /** An exact type, a prefix (`member.*`) or `*`; absent, `ping` and `tool.*` stay out. */
  type?: string;
  /** Milliseconds: rows at or after this time only. */
  since?: number;
}

/**
 * One event as Admin → Activity → Audit lists it: when, who, what (the
 * type in plain words) and what it was about. Never the event's data. The
 * Gateway's one-line summary (the catalogue's `summarize`) lives in the
 * Worker, so the CLI shows the type and the subject instead.
 */
interface AuditRow {
  id: string;
  time: number;
  type: string;
  /** The type in plain words (the SDK's catalogue; "App event: …" for an app's own). */
  label: string;
  actor: AuditActor;
  subject: AuditSubject;
  /** True for an app's own event (`app.<id>.<name>`). */
  appEvent: boolean;
}

/**
 * One page of the organization's audit log, newest first: the same rows,
 * filters and cursor as `everyapp_workspace_audit` (the Gateway's
 * `EventRepository.listForAudit`). Keyset on (time, id). A user actor
 * shows by their current name and email from `users`, the stored JSON
 * being the fallback; a row an older CLI wrote without the actor columns
 * still reads by its JSON.
 */
export async function audit(
  ws: Workspace,
  filters: AuditFilters,
): Promise<{ events: AuditRow[]; nextBefore: AuditCursor | null }> {
  await requireAuditColumns(ws.db);
  const limit = Math.min(Math.max(1, Math.trunc(filters.limit ?? 50) || 1), AUDIT_PAGE_MAX);
  const conditions = ["e.organization_id = ?"];
  const params: Array<string | number> = [ws.organization.id];
  if (filters.before) {
    conditions.push("(e.time < ? OR (e.time = ? AND e.id < ?))");
    params.push(filters.before.time, filters.before.time, filters.before.id);
  }
  if (filters.actorId !== undefined) {
    conditions.push("e.actor_id = ?");
    params.push(filters.actorId);
  }
  if (filters.type === undefined) {
    conditions.push("e.type <> 'ping' AND e.type NOT LIKE 'tool.%'");
  } else {
    const value = filters.type.trim();
    if (value.length === 0 || value.length > AUDIT_TYPE_MAX || !AUDIT_TYPE_FILTER.test(value)) {
      throw new EveryAppError(
        "INVALID_EVENT_TYPE",
        `--type is an event type (member.joined), a prefix (member.*, app.crm.*) or *${value ? ` (not ${value})` : ""}`,
      );
    }
    const condition = auditTypeCondition(value);
    if (condition?.op === "eq") {
      conditions.push("e.type = ?");
      params.push(condition.value);
    } else if (condition) {
      // substr, not LIKE: a type has underscores (mcp_app.), which LIKE takes as wildcards.
      conditions.push("substr(e.type, 1, ?) = ?");
      params.push(condition.value.length, condition.value);
    }
  }
  if (filters.since !== undefined) {
    conditions.push("e.time >= ?");
    params.push(filters.since);
  }
  params.push(limit + 1);
  const [rows = []] = await ws.db.run([
    {
      sql: `SELECT e.id, e.time, e.type, e.actor, e.actor_kind, e.actor_id, e.data, u.email AS user_email, u.name AS user_name
FROM events e
LEFT JOIN users u ON e.actor_kind = 'user' AND u.id = e.actor_id
WHERE ${conditions.join(" AND ")}
ORDER BY e.time DESC, e.id DESC LIMIT ?`,
      params,
    },
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => {
      const stored = auditActorOf(row["actor"]);
      const kind = text(row["actor_kind"]) ?? stored.kind;
      const id = text(row["actor_id"]) ?? stored.id;
      const actor: AuditActor =
        kind === "user"
          ? { kind, id, email: text(row["user_email"]) ?? stored.email, name: text(row["user_name"]) ?? stored.name }
          : { kind, id, email: stored.email, name: stored.name };
      let data: unknown = {};
      try {
        data = JSON.parse(String(row["data"]));
      } catch {
        data = {};
      }
      const type = String(row["type"]);
      return {
        id: String(row["id"]),
        time: number(row["time"]),
        type,
        label: auditTypeLabel(type),
        actor,
        subject: auditSubjectOf(type, data),
        appEvent: isAppOwnEventType(type),
      };
    }),
    nextBefore: rows.length > limit && last ? { time: number(last["time"]), id: String(last["id"]) } : null,
  };
}

/** A personal access token as listed: never its hash, never its value. */
export interface WorkspaceToken {
  id: string;
  user: { id: string; email: string };
  name: string;
  /** `epat_` and four characters: what a person recognizes it by. */
  prefix: string;
  app: { rowId: string | null; slug: string | null; name: string | null };
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Usable now: not revoked, not expired. */
  active: boolean;
}

const TOKEN_SQL = `SELECT t.id, t.user_id, u.email, t.name, t.token_prefix, t.app_row_id, a.app_slug, a.name AS app_name,
  t.scopes, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
FROM user_access_tokens t JOIN users u ON u.id = t.user_id
LEFT JOIN apps a ON a.id = t.app_row_id AND a.organization_id = t.organization_id
WHERE t.organization_id = ?1`;

function toToken(row: D1Row, now: number): WorkspaceToken {
  const revokedAt = row["revoked_at"] == null ? null : Number(row["revoked_at"]);
  const expiresAt = number(row["expires_at"]);
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row["scopes"] ?? "[]"));
    scopes = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    scopes = [];
  }
  return {
    id: String(row["id"]),
    user: { id: String(row["user_id"]), email: String(row["email"]) },
    name: String(row["name"]),
    prefix: String(row["token_prefix"]),
    app: { rowId: text(row["app_row_id"]), slug: text(row["app_slug"]), name: text(row["app_name"]) },
    scopes,
    createdAt: number(row["created_at"]),
    expiresAt,
    lastUsedAt: row["last_used_at"] == null ? null : Number(row["last_used_at"]),
    revokedAt,
    active: revokedAt === null && expiresAt > now,
  };
}

/** Every member's personal access tokens for the organization, newest first; one member's with `userId`. */
export async function listTokens(ws: Workspace, userId?: string): Promise<WorkspaceToken[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `${TOKEN_SQL}${userId ? " AND t.user_id = ?2" : ""} ORDER BY t.created_at DESC`,
      params: userId ? [ws.organization.id, userId] : [ws.organization.id],
    },
  ]);
  return rows.map((row) => toToken(row, ws.now));
}

/** Revoke a personal access token of the organization by id (UserPatService.revoke). */
export async function revokeToken(
  ws: Workspace,
  id: string,
): Promise<{ token: WorkspaceToken; already: boolean }> {
  const [rows = []] = await ws.db.run([
    { sql: `${TOKEN_SQL} AND t.id = ?2`, params: [ws.organization.id, id.trim()] },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError("TOKEN_NOT_FOUND", `No personal access token ${id.trim()} in ${ws.organization.name}`, {
      rerun: `${CLI} workspace tokens`,
      rerunNote: "lists them by id",
    });
  }
  const token = toToken(row, ws.now);
  if (token.revokedAt !== null) return { token, already: true };
  await ws.db.run([
    {
      sql: "UPDATE user_access_tokens SET revoked_at = ?3, updated_at = ?3 WHERE id = ?1 AND organization_id = ?2 AND revoked_at IS NULL",
      params: [token.id, ws.organization.id, ws.now],
    },
  ]);
  return { token: { ...token, revokedAt: ws.now, active: false }, already: false };
}

/** An AI connection (an OAuth client at the Gateway's /mcp) as listed. */
export interface WorkspaceConnection {
  id: string;
  user: { id: string; email: string };
  clientName: string;
  clientDomain: string | null;
  redirectHost: string;
  /** "all" apps the member can use, or the selected apps by id. */
  apps: "all" | string[];
  access: "read" | "write";
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

const CONNECTION_SQL = `SELECT c.id, c.user_id, u.email, c.client_name, c.client_domain, c.redirect_host, c.app_scope, c.access,
  c.created_at, c.last_used_at, c.revoked_at, c.revoked_reason,
  (SELECT group_concat(a.app_slug, char(31)) FROM mcp_connection_apps ca JOIN apps a ON a.id = ca.app_row_id WHERE ca.connection_id = c.id) AS app_slugs
FROM mcp_connections c JOIN users u ON u.id = c.user_id
WHERE c.organization_id = ?1`;

function toConnection(row: D1Row): WorkspaceConnection {
  return {
    id: String(row["id"]),
    user: { id: String(row["user_id"]), email: String(row["email"]) },
    clientName: String(row["client_name"]),
    clientDomain: text(row["client_domain"]),
    redirectHost: String(row["redirect_host"]),
    apps: row["app_scope"] === "all" ? "all" : (text(row["app_slugs"])?.split("\u001f").sort() ?? []),
    access: row["access"] === "write" ? "write" : "read",
    createdAt: number(row["created_at"]),
    lastUsedAt: row["last_used_at"] == null ? null : Number(row["last_used_at"]),
    revokedAt: row["revoked_at"] == null ? null : Number(row["revoked_at"]),
    revokedReason: text(row["revoked_reason"]),
  };
}

/** Every member's active AI connections to the organization, newest first; one member's with `userId`. */
export async function listConnections(ws: Workspace, userId?: string): Promise<WorkspaceConnection[]> {
  const [rows = []] = await ws.db.run([
    {
      sql: `${CONNECTION_SQL} AND c.revoked_at IS NULL${userId ? " AND c.user_id = ?2" : ""} ORDER BY c.created_at DESC`,
      params: userId ? [ws.organization.id, userId] : [ws.organization.id],
    },
  ]);
  return rows.map(toConnection);
}

/**
 * Revoke an AI connection by id (McpConnectionService.revokeForUser): the
 * row is what every /mcp request checks, so the client is out on its next
 * request. Its grant in the authorization server lapses on its own; the
 * CLI can't reach OAUTH_KV, and doesn't need to.
 */
export async function revokeConnection(
  ws: Workspace,
  id: string,
): Promise<{ connection: WorkspaceConnection; already: boolean }> {
  const [rows = []] = await ws.db.run([
    { sql: `${CONNECTION_SQL} AND c.id = ?2`, params: [ws.organization.id, id.trim()] },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError("CONNECTION_NOT_FOUND", `No AI connection ${id.trim()} in ${ws.organization.name}`, {
      rerun: `${CLI} workspace connections`,
      rerunNote: "lists them by id",
    });
  }
  const connection = toConnection(row);
  if (connection.revokedAt !== null) return { connection, already: true };
  await ws.db.run([
    {
      sql: `UPDATE mcp_connections SET revoked_at = ?3, revoked_by = ?4, revoked_reason = 'user'
WHERE id = ?1 AND organization_id = ?2 AND revoked_at IS NULL`,
      params: [connection.id, ws.organization.id, ws.now, ws.operator.userId],
    },
  ]);
  return { connection: { ...connection, revokedAt: ws.now, revokedReason: "user" }, already: false };
}
