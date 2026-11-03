/**
 * The app side of a connection (docs/design/2026-11-oauth-simplify.md):
 * which app a connect is for, and whether a member may use a connection in
 * an app. A connection belongs to one person and one app, so both the
 * connect and every background use of someone's connection ask here.
 */
import { and, eq } from "drizzle-orm";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { db } from "@/db";
import { members, users } from "@/db/schema";
import { AppRepository } from "@/server/repositories/AppRepository";
import { effectiveAccess } from "@/server/repositories/effective-access";
import { isUserBanned } from "@/server/user-ban";

/** The app a connect is for, as the flow needs it. */
interface ConnectApp {
  /** apps.id. */
  rowId: string;
  /** The app's id (its slug). */
  slug: string;
  name: string;
  /** The deployed manifest, parsed; null when unreadable. */
  manifest: Record<string, unknown> | null;
}

function parseManifest(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the member is in the organization, not deactivated, and opens
 * the organization's app `appRowId` (a direct or group grant).
 */
export async function memberMayUseApp(input: {
  organizationId: string;
  userId: string;
  appRowId: string;
  now?: number;
}): Promise<boolean> {
  const [row] = await db
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, input.organizationId),
        eq(members.userId, input.userId),
      ),
    )
    .limit(1);
  if (!row || isUserBanned(row, input.now)) return false;
  const access = effectiveAccess(input.organizationId);
  const [grant] = await db
    .select({ appRowId: access.appRowId })
    .from(access)
    .where(
      and(eq(access.userId, input.userId), eq(access.appRowId, input.appRowId)),
    )
    .limit(1);
  return Boolean(grant);
}

/**
 * The app `slug` names for a signed-in member of `organizationId`: the
 * organization's own app they open, else (when the gateway serves shared
 * apps) a shared app with that id. Null when there is none, it was deleted
 * or the member doesn't open it.
 */
export async function appForMember(input: {
  organizationId: string;
  userId: string;
  slug: string;
  sharedApps: boolean;
}): Promise<ConnectApp | null> {
  const own = await AppRepository.findByAppSlug(
    input.slug,
    input.organizationId,
  );
  if (own && own.status !== "deleted" && own.tier !== PROVIDER_APP_TIER) {
    const opens = await memberMayUseApp({
      organizationId: input.organizationId,
      userId: input.userId,
      appRowId: own.id,
    });
    return opens
      ? {
          rowId: own.id,
          slug: own.appSlug,
          name: own.name,
          manifest: parseManifest(own.manifest),
        }
      : null;
  }
  if (!input.sharedApps) return null;
  const shared = (await AppRepository.findAllShared(input.organizationId)).find(
    (app) => app.appSlug === input.slug && app.tier !== PROVIDER_APP_TIER,
  );
  return shared
    ? {
        rowId: shared.id,
        slug: shared.appSlug,
        name: shared.name,
        manifest: parseManifest(shared.manifest),
      }
    : null;
}
