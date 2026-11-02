/**
 * Background use of a member's own OAuth connection
 * (docs/design/2026-11-birds-decisions/888-background-oauth.md): the
 * grants a member makes on the Gateway's page (./backgroundPage.ts), what
 * the held-token proxy asks before it uses one (`gatewayBackgroundGrants`),
 * the daily `connection.used`, the perimeter's daily "the member opened
 * the app" touch, revocation by the member or an owner or admin, and the
 * hourly lapse sweep. A grant lives while the member is in the
 * organization, not deactivated, opens the app, the app is the
 * organization's own and active, the connection is the one granted, and
 * the member opened the app within {@link BACKGROUND_IDLE_DAYS} days.
 */
import { waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { emit } from "@/server/events/bus";
import { catalogue, type EventApp } from "@/server/events/catalogue";
import {
  GATEWAY_ACTOR,
  userActor,
  userSubject,
} from "@/server/events/subjects";
import { gatewayProviders } from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  BackgroundGrantRepository,
  type BackgroundGrant,
  type BackgroundGrantEnd,
} from "@/server/repositories/BackgroundGrantRepository";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import type { BackgroundGrantPort } from "@/server/capabilities/heldToken";
import { BACKGROUND_IDLE_DAYS } from "./backgroundSeen";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Grants the hourly sweep ends at most in one run. */
const SWEEP_LIMIT = 1000;

/** The Gateway page where a member allows an app's background use. */
function backgroundConsentPath(providerId: string, appSlug: string): string {
  return `/connect/${encodeURIComponent(providerId)}/background?app=${encodeURIComponent(appSlug)}`;
}

/** The provider's name for events and pages: its label, else its id. */
async function providerName(providerId: string): Promise<string> {
  try {
    return (await gatewayProviders()).get(providerId)?.label ?? providerId;
  } catch {
    return providerId;
  }
}

async function eventApp(
  appRowId: string,
  organizationId: string,
): Promise<EventApp> {
  const row = await AppRepository.findById(appRowId, organizationId).catch(
    () => undefined,
  );
  return row
    ? { id: row.appSlug, rowId: row.id, name: row.name }
    : { id: "unknown", rowId: appRowId, name: "a removed app" };
}

async function eventUser(userId: string) {
  const member = await userSubject(userId).catch(() => null);
  return member ?? { id: userId, email: null, name: null };
}

/** `provider.background_granted`, once the page recorded the grant. */
export async function announceGranted(grant: BackgroundGrant): Promise<void> {
  logEvent("oauth.background_granted", {
    provider: grant.providerId,
    org: grant.organizationId,
    user_id: grant.userId,
    app_row_id: grant.appRowId,
    scopeSets: grant.scopeSets,
  });
  await emit(async () => ({
    organizationId: grant.organizationId,
    actor: await userActor(grant.userId),
    ...catalogue.providerBackgroundGranted({
      provider: {
        id: grant.providerId,
        name: await providerName(grant.providerId),
        kind: "oauth",
      },
      app: await eventApp(grant.appRowId, grant.organizationId),
      user: await eventUser(grant.userId),
      grantId: grant.id,
      scopeSets: grant.scopeSets,
    }),
  }));
}

/**
 * End a grant and say so: `provider.background_revoked` with the actor
 * for a revocation, `provider.background_lapsed` with the reason
 * otherwise. False when it had already ended.
 */
async function endGrant(
  grantId: string,
  reason: BackgroundGrantEnd,
  by: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const ended = await BackgroundGrantRepository.end(grantId, {
    reason,
    by,
    now,
  });
  if (!ended) return false;
  logEvent("oauth.background_ended", {
    provider: ended.providerId,
    org: ended.organizationId,
    user_id: ended.userId,
    app_row_id: ended.appRowId,
    reason,
    ...(by ? { by } : {}),
  });
  const revoked = reason === "revoked" || reason === "admin_revoked";
  await emit(async () => {
    const common = {
      provider: {
        id: ended.providerId,
        name: await providerName(ended.providerId),
        kind: "oauth" as const,
      },
      app: await eventApp(ended.appRowId, ended.organizationId),
      user: await eventUser(ended.userId),
      grantId: ended.id,
    };
    return {
      organizationId: ended.organizationId,
      actor: by ? await userActor(by) : GATEWAY_ACTOR,
      ...(revoked
        ? catalogue.providerBackgroundRevoked({
            ...common,
            by: reason === "admin_revoked" ? "admin" : "member",
          })
        : catalogue.providerBackgroundLapsed({ ...common, reason })),
    };
  });
  return true;
}

/**
 * Revoke a grant: the member's own (`asAdmin` false), or any in the
 * organization for an owner or admin. False when it isn't theirs to
 * revoke, or had already ended.
 */
export async function revokeBackgroundGrant(input: {
  grantId: string;
  organizationId: string;
  actorUserId: string;
  asAdmin: boolean;
}): Promise<boolean> {
  const grant = await BackgroundGrantRepository.byId(input.grantId);
  if (!grant || grant.organizationId !== input.organizationId) return false;
  if (!input.asAdmin && grant.userId !== input.actorUserId) return false;
  const own = grant.userId === input.actorUserId;
  return endGrant(
    grant.id,
    own ? "revoked" : "admin_revoked",
    input.actorUserId,
  );
}

/** A connection was disconnected: end its grants now, not at the next sweep. */
export async function endGrantsForConnection(
  connectionId: string,
  by: string | null,
): Promise<number> {
  let ended = 0;
  for (const grant of await BackgroundGrantRepository.liveForConnection(
    connectionId,
  )) {
    if (await endGrant(grant.id, "disconnected", by)) ended += 1;
  }
  return ended;
}

/** A member's live grants, or (an owner or admin) every one in the organization, for the pages. */
export async function listBackgroundGrants(input: {
  organizationId: string;
  userId: string | "all";
}) {
  const grants =
    input.userId === "all"
      ? await BackgroundGrantRepository.listForOrganization(
          input.organizationId,
        )
      : await BackgroundGrantRepository.listForUser(
          input.userId,
          input.organizationId,
        );
  const names = new Map<string, string>();
  for (const grant of grants) {
    if (!names.has(grant.providerId)) {
      names.set(grant.providerId, await providerName(grant.providerId));
    }
  }
  return grants.map((grant) => ({
    id: grant.id,
    providerId: grant.providerId,
    providerName: names.get(grant.providerId) ?? grant.providerId,
    connectionLabel: grant.connectionLabel,
    app: grant.app,
    user: { id: grant.userId, ...grant.user },
    scopeSets: grant.scopeSets,
    grantedAt: grant.grantedAt,
    lastUsedAt: grant.lastUsedAt,
    lastSeenAt: grant.lastSeenAt,
    lapsesAt: grant.lastSeenAt + BACKGROUND_IDLE_DAYS * DAY_MS,
  }));
}

/**
 * The hourly sweep: end every live grant whose member left, was
 * deactivated or lost the app, whose app was removed or disabled, whose
 * connection is gone, or whose member hasn't opened the app in
 * {@link BACKGROUND_IDLE_DAYS} days. The count ended.
 */
export async function lapseBackgroundGrants(
  now: Date = new Date(),
): Promise<number> {
  const due = await BackgroundGrantRepository.toLapse({
    idleBefore: new Date(now.getTime() - BACKGROUND_IDLE_DAYS * DAY_MS),
    now,
    limit: SWEEP_LIMIT,
  });
  let ended = 0;
  for (const { grant, reason } of due) {
    if (await endGrant(grant.id, reason, null, now)) ended += 1;
  }
  return ended;
}

/**
 * The held-token proxy's questions about one calling app
 * (capabilities/heldToken.ts): only a first-party organization app with a
 * registry row can use a member's connection in the background (v1).
 */
export function gatewayBackgroundGrants(app: {
  rowId?: string;
  appId: string;
  scope: string;
  tier?: string;
  organizationId: string;
}): BackgroundGrantPort {
  const eligible =
    Boolean(app.rowId) &&
    app.scope === "org" &&
    (app.tier === undefined || app.tier === "service_binding");
  return {
    consentPath: (providerId) => backgroundConsentPath(providerId, app.appId),
    async authorize({ organizationId, userId, connectionId, sets }) {
      if (!eligible || !app.rowId) {
        return {
          ok: false,
          reason:
            "only an organization's own app can use a member's connection in the background",
        };
      }
      if (organizationId !== app.organizationId) {
        return { ok: false, reason: "the organization isn't the app's" };
      }
      const grant = await BackgroundGrantRepository.findLive(
        connectionId,
        app.rowId,
      );
      if (!grant || grant.userId !== userId) {
        return {
          ok: false,
          reason: "this member hasn't allowed this app's background use",
        };
      }
      const now = Date.now();
      if (grant.lastSeenAt < now - BACKGROUND_IDLE_DAYS * DAY_MS) {
        await endGrant(grant.id, "idle", null).catch(() => false);
        return {
          ok: false,
          reason: `this member hasn't opened the app in ${BACKGROUND_IDLE_DAYS} days, so the background use lapsed`,
        };
      }
      const missing = sets.filter((set) => !grant.scopeSets.includes(set));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `this member allowed background use of ${grant.scopeSets.join(", ") || "no sets"}, not ${missing.join(", ")}`,
        };
      }
      const mayUse = await BackgroundGrantRepository.memberMayUse({
        organizationId,
        userId,
        appRowId: app.rowId,
        now,
      });
      if (!mayUse) {
        return {
          ok: false,
          reason:
            "this member is no longer active in the organization, or no longer opens this app",
        };
      }
      return { ok: true, grantId: grant.id };
    },
    used({ grantId, organizationId, userId, providerId, providerLabel }) {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
      const appRowId = app.rowId;
      if (!appRowId) return;
      const task = RateLimitCounterRepository.claimOnce(
        `background:used:${grantId}:${day}`,
        new Date(tomorrow),
      )
        .then(async (first) => {
          if (!first) return;
          await BackgroundGrantRepository.touchUsed(grantId, now);
          await emit(async () => ({
            organizationId,
            actor: { kind: "app" as const, id: app.appId },
            ...catalogue.backgroundUsed({
              grantId,
              provider: { id: providerId, name: providerLabel, kind: "oauth" },
              app: await eventApp(appRowId, organizationId),
              user: await eventUser(userId),
            }),
          }));
        })
        .catch((error: unknown) => {
          logEvent(
            "oauth.background_used_failed",
            { error: error instanceof Error ? error.name : "unknown" },
            "warn",
          );
        });
      try {
        waitUntil(task);
      } catch {
        // Outside a request (tests): the task runs on its own.
      }
    },
  };
}
