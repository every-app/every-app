/**
 * What every identity provider's sign-in has in common once the provider
 * has said who someone is (Cloudflare Access: ./cloudflare-access/membership.ts;
 * the sign-in providers: ./sign-in-providers/membership.ts): whether the
 * gateway has an owner yet, the pending invitations for a verified email,
 * and accepting them the way the accept page would.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { invitations, members } from "@/db/schema";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { actorOf } from "@/server/events/subjects";
import { AppAccessService } from "@/server/services/AppAccessService";

/** Which way in accepted the invitation, for the log and the event bus. */
interface IdentityJoinVia {
  /** The `invitation.accepted` log line's `via`. */
  log: string;
  /** The `member.joined` event's `via`. */
  event: "access" | "sign_in";
}

/** The organization of the gateway's first owner, or null before the claim. */
export async function findOwnerOrganizationId(): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.role, "owner"))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}

/** The pending, unexpired invitations for a lowercased email. */
export function pendingInvitationsFor(email: string) {
  return db
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      role: invitations.role,
    })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
}

/**
 * Accept every pending invitation for this verified email, as the accept
 * page would: the invited role, and the organization's default apps. Each
 * invitation is claimed by flipping its status first, so two sign-ins at
 * once can't both use it. Returns how many were accepted.
 */
export async function acceptPendingInvitations(
  user: { id: string; email: string; name: string | null },
  via: IdentityJoinVia,
): Promise<number> {
  const joined = { id: user.id, email: user.email, name: user.name };
  let accepted = 0;
  for (const invitation of await pendingInvitationsFor(user.email)) {
    const claimed = await db
      .update(invitations)
      .set({ status: "accepted" })
      .where(
        and(
          eq(invitations.id, invitation.id),
          eq(invitations.status, "pending"),
        ),
      )
      .returning({ id: invitations.id });
    if (claimed.length === 0) continue;

    await db.insert(members).values({
      id: crypto.randomUUID(),
      organizationId: invitation.organizationId,
      userId: user.id,
      role: invitation.role ?? "member",
      createdAt: new Date(),
    });
    await AppAccessService.grantDefaultAppsToUser(
      user.id,
      invitation.organizationId,
    );
    logEvent("invitation.accepted", {
      organizationId: invitation.organizationId,
      userId: user.id,
      via: via.log,
    });
    await emit({
      organizationId: invitation.organizationId,
      actor: actorOf(joined),
      ...catalogue.memberJoined({
        user: joined,
        role: invitation.role ?? "member",
        via: via.event,
      }),
    });
    accepted += 1;
  }
  return accepted;
}
