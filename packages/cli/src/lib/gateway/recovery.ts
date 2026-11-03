/**
 * The operator's two links, written into the Gateway's D1 under the
 * Cloudflare login (ADR-0003, "What the CLI writes"). They are the admin
 * writes that can't go through the Gateway's tools, which never hand a
 * credential back to their caller (parity decision 2).
 *
 * - The recovery link (`workspace reset-link`): the way back in for a
 *   member locked out of the Gateway (a sole owner who lost their password,
 *   on a Gateway that sends no email). A one-hour, single-use password
 *   reset: Better Auth's own `verifications` row, which the Gateway's
 *   /reset-password page consumes. Only for an active member of the install
 *   organization that belongs to no other organization: a password is
 *   account-wide, so a reset through one organization would reach the
 *   others (the Gateway's `requireAccountWideManageable`).
 * - The invite link (`workspace invite-link`): a new link for a pending
 *   invitation of the install organization, for a Gateway that sends no
 *   email (InvitationService.getInvitationLink). An `einv_` token whose
 *   SHA-256 goes into `invitation_link_tokens`; earlier links keep working,
 *   and the Gateway still checks the inviter when the link is opened.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { installOrganization, type Organization } from "./registry";

const RESET_LINK_TTL_MS = 60 * 60 * 1000;

interface RecoveryLink {
  member: { id: string; email: string; name: string | null };
  organization: { id: string; name: string };
  url: string;
  expiresAt: number;
}

/** The install organization, or ORGANIZATION_NOT_FOUND before the Gateway has one. */
async function requireInstallOrganization(db: D1Database): Promise<Organization> {
  const install = await installOrganization(db);
  if (!install) {
    throw new EveryAppError("ORGANIZATION_NOT_FOUND", "The Gateway has no organization yet\nIts owner creates the first one by claiming it.", {
      rerun: `${CLI} setup`,
      rerunNote: "prints the owner link",
    });
  }
  return install.organization;
}

export async function mintRecoveryLink(
  db: D1Database,
  gatewayUrl: string,
  email: string,
  now: number = Date.now(),
): Promise<RecoveryLink> {
  const organization = await requireInstallOrganization(db);
  const address = email.trim().toLowerCase();
  const [members = []] = await db.run([
    {
      sql: `SELECT u.id, u.name, u.email, u.banned, u.ban_expires,
  (SELECT COUNT(*) FROM members o WHERE o.user_id = u.id AND o.organization_id != ?1) AS other_organizations
FROM members m JOIN users u ON u.id = m.user_id
WHERE m.organization_id = ?1 AND (lower(u.email) = ?2 OR u.id = ?3)`,
      params: [organization.id, address, email.trim()],
    },
  ]);
  const row = members[0];
  if (!row) {
    throw new EveryAppError("USER_NOT_FOUND", `No member ${address} in ${organization.name}`, {
      data: { organization, email: address },
    });
  }
  const member = { id: String(row["id"]), email: String(row["email"]), name: row["name"] == null ? null : String(row["name"]) };
  const banExpires = row["ban_expires"] == null ? null : Number(row["ban_expires"]);
  if (Number(row["banned"] ?? 0) === 1 && (banExpires === null || banExpires > now)) {
    throw new EveryAppError(
      "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      `${member.email} is deactivated, and a password-reset link is only for an active account`,
      { data: { member } },
    );
  }
  if (Number(row["other_organizations"] ?? 0) > 0) {
    throw new EveryAppError(
      "USER_IN_OTHER_ORGANIZATION",
      `${member.email} also belongs to another organization, and a password is account-wide\nThe Gateway's own rule: a password-reset link is never made for someone in another organization, since it would reach that one too.`,
      { fix: "they reset it themselves with Forgot password (the Gateway's email must be configured)", data: { member } },
    );
  }
  const token = randomBytes(24).toString("base64url");
  const expiresAt = now + RESET_LINK_TTL_MS;
  await db.run([
    {
      sql: `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      params: [randomUUID(), `reset-password:${token}`, member.id, expiresAt, now],
    },
  ]);
  return {
    member,
    organization: { id: organization.id, name: organization.name },
    url: `${gatewayUrl}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

interface InvitationLink {
  invitation: { id: string; email: string; role: string };
  organization: { id: string; name: string };
  url: string;
  expiresAt: number;
}

/**
 * A new link for a pending, unexpired invitation of the install
 * organization, by its id or invited email (the newest, for an email). The
 * token is written only while the invitation is still pending, so one used
 * or canceled meanwhile gets no link.
 */
export async function mintInvitationLink(
  db: D1Database,
  gatewayUrl: string,
  identifier: string,
  now: number = Date.now(),
): Promise<InvitationLink> {
  const organization = await requireInstallOrganization(db);
  const wanted = identifier.trim();
  const [rows = []] = await db.run([
    {
      sql: `SELECT id, email, role, expires_at FROM invitations
WHERE organization_id = ?1 AND status = 'pending' AND (id = ?2 OR lower(email) = lower(?2))
ORDER BY (id = ?2) DESC, created_at DESC LIMIT 1`,
      params: [organization.id, wanted],
    },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError(
      "INVITATION_NOT_PENDING",
      `No pending invitation for ${wanted} in ${organization.name}\nIt was accepted, canceled or never made.`,
      { rerun: `${CLI} workspace users`, rerunNote: "lists the pending invitations" },
    );
  }
  const invitation = { id: String(row["id"]), email: String(row["email"]), role: String(row["role"] ?? "member") };
  const expiresAt = Number(row["expires_at"]);
  if (!(expiresAt > now)) {
    throw new EveryAppError(
      "INVITATION_NOT_PENDING",
      `The invitation for ${invitation.email} expired on ${new Date(expiresAt).toISOString()}`,
      { rerun: `${CLI} workspace invite ${invitation.email}`, rerunNote: "makes a new one" },
    );
  }
  const token = `einv_${randomBytes(32).toString("base64url")}`;
  const [written = []] = await db.run([
    {
      sql: `INSERT INTO invitation_link_tokens (id, invitation_id, token_hash, created_at)
SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ?2 AND status = 'pending' AND expires_at > ?4)
RETURNING id`,
      params: [randomUUID(), invitation.id, createHash("sha256").update(token).digest("hex"), now],
    },
  ]);
  if (written.length === 0) {
    throw new EveryAppError("INVITATION_NOT_PENDING", `The invitation for ${invitation.email} was used or canceled meanwhile`);
  }
  return {
    invitation,
    organization: { id: organization.id, name: organization.name },
    url: `${gatewayUrl}/accept-invitation?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}
