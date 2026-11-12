/**
 * What the Gateway's Allow page shows
 * (docs/design/2026-11-oauth-one-connection.md, routes/oauth/app-access.tsx):
 * the app asking to use the person's connection to a provider, the account
 * that connection is to, what the app says it does with it and the scopes
 * it lists. Read from the one-use `allow` state the connect started
 * (./flow.ts), which stays in place: the page's form spends it, and the
 * form's handler checks everything here again.
 */
import { missingScopes } from "@every-app/sdk/internal";
import type { OrgContext } from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { declaredScopes, declaredWhy, memberAppByRow } from "./appAccess";

/** Why an Allow page, or its form, can't go ahead. */
export enum AllowRefusal {
  /** The provider is gone, or the app no longer lists it or opens for the person. */
  App = "app",
  /** The person's connection expired, went, or no longer holds what the app lists. */
  Connection = "connection",
  /** The app lists more than the state (what the page showed). */
  Scopes = "scopes",
}

/**
 * What the Allow page and its form (flow.ts) both check about an `allow`
 * state, in order: the provider and the app, the person's connection, and
 * that the app lists no more than the state holds.
 */
export async function allowCheck(
  person: { id: string; org: { orgId: string } },
  state: { providerId: string; appRowId: string; scopes: readonly string[] },
) {
  const capability = (await gatewayProviders()).get(state.providerId);
  const app = await memberAppByRow({
    organizationId: person.org.orgId,
    userId: person.id,
    appRowId: state.appRowId,
  });
  const declared = app ? declaredScopes(app.manifest, state.providerId) : null;
  if (
    !capability ||
    capability.mode !== "oauth_client" ||
    !app ||
    declared === null
  ) {
    return { refused: AllowRefusal.App } as const;
  }
  const connection = await ProviderConnectionRepository.find({
    organizationId: person.org.orgId,
    providerId: state.providerId,
    userId: person.id,
  });
  if (
    connection?.status !== "active" ||
    missingScopes(capability.flow, connection.scopes, declared).length > 0
  ) {
    return { refused: AllowRefusal.Connection, capability, app } as const;
  }
  if (missingScopes(capability.flow, state.scopes, declared).length > 0) {
    return { refused: AllowRefusal.Scopes, capability, app } as const;
  }
  return { refused: null, capability, app, declared, connection } as const;
}

export type AppAccessContext =
  | { ok: false; message: string }
  | {
      ok: true;
      /** The one-use state the form posts back. */
      state: string;
      /** Where the form posts: `/connect/<provider>/allow`. */
      action: string;
      /** The signed-in person's email. */
      email: string;
      provider: { id: string; name: string };
      /** The app asking, with what its launcher icon is drawn from. */
      app: {
        id: string;
        name: string;
        hostname: string | null;
        status: string;
        /** The path of the icon the app's manifest names, or null. */
        icon: string | null;
      };
      /** How the provider names the connected account, when it says. */
      account: string | null;
      /** What the app says it does with the account, when its manifest says. */
      why: string | null;
      /** The scopes the app lists, as it wrote them. */
      scopes: string[];
    };

const GONE: AppAccessContext = {
  ok: false,
  message: "This page was used already or expired. Open the app again.",
};

export async function buildAppAccessContext(
  person: { id: string; email: string; org: OrgContext },
  stateParam: string,
  now: number = Date.now(),
): Promise<AppAccessContext> {
  const state = await OAuthStateRepository.peek(stateParam, new Date(now));
  if (
    !state ||
    state.purpose !== OAuthStatePurpose.Allow ||
    state.userId !== person.id ||
    state.organizationId !== person.org.orgId
  ) {
    return GONE;
  }
  const check = await allowCheck(person, state);
  if (check.refused === AllowRefusal.Connection) {
    return {
      ok: false,
      message: `Your ${check.capability.label} connection changed since this page opened. Open ${check.app.name} and connect again.`,
    };
  }
  // The state holds the scopes the app listed when the connect started;
  // the form's handler allows no more than those. An app that lists more
  // by now starts again, so the page never shows less than is allowed.
  if (check.refused !== null) return GONE;
  const { capability, app, declared, connection } = check;
  const icon = app.manifest?.["icon"];
  return {
    ok: true,
    state: state.state,
    action: `/connect/${encodeURIComponent(state.providerId)}/allow`,
    email: person.email,
    provider: { id: state.providerId, name: capability.label },
    app: {
      id: app.slug,
      name: app.name,
      hostname: app.hostname,
      status: app.status,
      icon: typeof icon === "string" ? icon : null,
    },
    account: connection.label,
    why: declaredWhy(app.manifest, state.providerId),
    scopes: [...declared],
  };
}
