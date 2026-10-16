/**
 * Personal organizations (platformPolicy's `personalOrgs`, the hosted
 * gateway): everyone who signs up without an invitation gets one
 * organization of their own, as its owner, and grows it by inviting people.
 * Nobody creates organizations any other way (`allowUserToCreateOrganization`
 * stays off), so each account has at most this one.
 *
 * The organization is marked as theirs (personal-marker.ts), which the
 * session uses to start there (orgContext.ts).
 */
import { eq } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { members, organizations } from "@/db/schema";
import { AppAccessService } from "@/server/services/AppAccessService";
import { personalOrganizationName, slugify } from "./organization-name";
import { personalOrganizationMetadata } from "./personal-marker";

const SLUG_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Six random [a-z0-9] characters, so two people called Sam get two slugs. */
function slugSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((byte) => SLUG_SUFFIX_ALPHABET[byte % SLUG_SUFFIX_ALPHABET.length])
    .join("");
}

/**
 * Create a new account's organization and its owner membership in one D1
 * batch (all or nothing), then give the owner the organization's default
 * apps. If any of it fails, nothing of it stays and this throws: the caller
 * removes the account too, so a sign-up never leaves an account without the
 * organization it was promised.
 */
export async function createPersonalOrganization(user: {
  id: string;
  name?: string | null;
  email: string;
}): Promise<{ organizationId: string }> {
  const name = personalOrganizationName(user);
  const organizationId = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(organizations).values({
      id: organizationId,
      name,
      slug: `${slugify(name).slice(0, 40) || "org"}-${slugSuffix()}`,
      createdAt: now,
      metadata: personalOrganizationMetadata(user.id),
      status: "active",
    }),
    db.insert(members).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    }),
  ]);
  try {
    await AppAccessService.grantDefaultAppsToUser(user.id, organizationId);
  } catch (error) {
    // The membership and any grants go with the organization (cascade).
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    throw error;
  }
  logEvent("organization.personal_created", {
    organizationId,
    userId: user.id,
  });
  return { organizationId };
}
