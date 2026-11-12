/**
 * The app side of a connection (docs/design/2026-11-oauth-one-connection.md):
 * which app a connect is for, whether a member may use a connection in an
 * app, and the scopes an organization's apps list for a provider. A
 * connection belongs to one person, and each app they allow uses it, so
 * the connect, the Allow page and every background use of someone's
 * connection ask here.
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { isRemoteMcpRow } from "@every-app/perimeter/registry";
import {
  PROVIDER_APP_TIER,
  jsonObject,
  missingScopes,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { db } from "@/db";
import { apps, members, users } from "@/db/schema";
import { ConnectionAction } from "@/schemas/app-access";
import { platformPolicy } from "@/server/platform-policy";
import { AppRepository } from "@/server/repositories/AppRepository";
import { accessToApp } from "@/server/repositories/effective-access";
import { isUserBanned } from "@/server/user-ban";

/** The app a connect is for, as the flow needs it. */
export interface ConnectApp {
  /** apps.id. */
  rowId: string;
  /** The app's id (its slug). */
  slug: string;
  name: string;
  hostname: string | null;
  status: string;
  /** The deployed manifest, parsed; null when unreadable. */
  manifest: Record<string, unknown> | null;
}

/** An app row's stored manifest, parsed; null when there is none or it doesn't read as an object. */
export function parseManifest(
  text: string | null,
): Record<string, unknown> | null {
  return text ? jsonObject(text) : null;
}

/** Whether the gateway serves shared apps to every organization. */
function sharedApps(): boolean {
  return platformPolicy(env).sharedApps;
}

/** An app's entry for the provider in its manifest's `capabilities`, or null when it lists none. */
function providerEntry(
  manifest: Record<string, unknown> | null,
  providerId: string,
): Record<string, unknown> | null {
  const capabilities = manifest?.["capabilities"];
  if (!capabilities || typeof capabilities !== "object") return null;
  const entry = (capabilities as Record<string, unknown>)[providerId];
  return entry && typeof entry === "object"
    ? (entry as Record<string, unknown>)
    : null;
}

/** The scope strings an app's entry for the provider lists, or null when it lists no entry. */
export function declaredScopes(
  manifest: Record<string, unknown> | null,
  providerId: string,
): string[] | null {
  const entry = providerEntry(manifest, providerId);
  if (!entry) return null;
  const scopes = entry["scopes"];
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/** What an app's entry for the provider says it does with the account (`why`), or null when it doesn't say. */
export function declaredWhy(
  manifest: Record<string, unknown> | null,
  providerId: string,
): string | null {
  const why = providerEntry(manifest, providerId)?.["why"];
  return typeof why === "string" && why.trim() ? why.trim() : null;
}

/**
 * The scopes every app the organization has lists for the provider, as
 * the apps wrote them, each once: what one connect asks the provider for,
 * so the connection holds what any of them needs. The organization's own
 * apps, and the shared ones when the gateway serves them.
 */
export async function scopesListedFor(input: {
  organizationId: string;
  providerId: string;
}): Promise<string[]> {
  const rows = [
    ...(await AppRepository.findAll(input.organizationId)),
    ...(sharedApps()
      ? await AppRepository.findAllShared(input.organizationId)
      : []),
  ];
  const out: string[] = [];
  for (const row of rows) {
    const listed = declaredScopes(
      parseManifest(row.manifest),
      input.providerId,
    );
    for (const scope of listed ?? []) {
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/**
 * Whether the member is in the organization, not deactivated, and opens
 * the organization's app `appRowId` (effective-access.ts: available to
 * everyone, an owner or admin role, a person's grant or a group's).
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
  const [opens] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        eq(apps.id, input.appRowId),
        accessToApp(input.userId, input.organizationId),
      ),
    )
    .limit(1);
  return Boolean(opens);
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
}): Promise<ConnectApp | null> {
  const own = await AppRepository.findByAppSlug(
    input.slug,
    input.organizationId,
  );
  // A remote MCP app (a provider-tier row with a `remote` block) connects
  // like a deployed app: its manifest lists its own OAuth provider.
  if (
    own &&
    own.status !== "deleted" &&
    (own.tier !== PROVIDER_APP_TIER || isRemoteMcpRow(own))
  ) {
    const opens = await memberMayUseApp({
      organizationId: input.organizationId,
      userId: input.userId,
      appRowId: own.id,
    });
    return opens ? connectApp(own) : null;
  }
  if (!sharedApps()) return null;
  const shared = (await AppRepository.findAllShared(input.organizationId)).find(
    (app) => app.appSlug === input.slug && app.tier !== PROVIDER_APP_TIER,
  );
  return shared ? connectApp(shared) : null;
}

function connectApp(row: {
  id: string;
  appSlug: string;
  name: string;
  hostname: string | null;
  status: string;
  manifest: string | null;
}): ConnectApp {
  return {
    rowId: row.id,
    slug: row.appSlug,
    name: row.name,
    hostname: row.hostname,
    status: row.status,
    manifest: parseManifest(row.manifest),
  };
}

/**
 * The app row `appRowId` names, as `appForMember` finds it for this
 * person: null when it is gone or they no longer open it.
 */
export async function memberAppByRow(input: {
  organizationId: string;
  userId: string;
  appRowId: string;
}): Promise<ConnectApp | null> {
  const row = await AppRepository.findCallableById(
    input.appRowId,
    input.organizationId,
  );
  const app = row
    ? await appForMember({
        organizationId: input.organizationId,
        userId: input.userId,
        slug: row.appSlug,
      })
    : null;
  return app?.rowId === input.appRowId ? app : null;
}

/**
 * What a person does before an app may use their connection, for what the
 * app lists (`declared`) now; null when nothing. The one rule behind the
 * connect link, the setup dialog's buttons and Needs reconnect.
 */
export function connectionAction(
  flow: OAuthClientCapability["flow"],
  connection: {
    status: "active" | "expired";
    scopes: readonly string[];
  } | null,
  access: { scopes: readonly string[] } | null,
  declared: readonly string[],
): ConnectionAction | null {
  if (!connection) return ConnectionAction.Connect;
  if (
    connection.status === "expired" ||
    missingScopes(flow, connection.scopes, declared).length > 0
  ) {
    return ConnectionAction.Reconnect;
  }
  if (!access || missingScopes(flow, access.scopes, declared).length > 0) {
    return ConnectionAction.Allow;
  }
  return null;
}
