/**
 * What the Gateway's Allow page shows
 * (docs/design/2026-11-oauth-one-connection.md, routes/oauth/app-access.tsx):
 * the app asking to use the person's connection to a provider, the account
 * that connection is to, what the app says it does with it and the scopes
 * it lists. Read from the one-use `allow` state the connect started
 * (./flow.ts), which stays in place: the page's form spends it, and the
 * form's handler checks everything here again.
 */
import {
  ConnectionVia,
  composioServicesNeeded,
  composioServicesOf,
  missingScopes,
} from "@every-app/sdk/internal";
import { providerServing } from "@/server/composio/link";
import type { OrgContext } from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import {
  connectionAction,
  declaredScopes,
  declaredWhy,
  memberAppByRow,
} from "./appAccess";
import { ConnectionAction } from "@/schemas/app-access";

/** Why an Allow page, or its form, can't go ahead. */
export enum AllowRefusal {
  /** The provider is gone, or the app no longer lists it or opens for the person. */
  App = "app",
  /** The person's connection expired, went, no longer holds what the app lists, or was made another way than the provider is served now. */
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
  const registry = await gatewayProviders();
  const capability = registry.get(state.providerId);
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
  const serving = await providerServing({
    organizationId: person.org.orgId,
    providerId: state.providerId,
    capability,
    lookup: registry,
  });
  // The connection is one a call would use: anything short of that (none,
  // expired, lacking, made the other way) is a connect, not an Allow.
  const action = connectionAction(
    { id: state.providerId, flow: capability.flow, via: serving.via },
    connection,
    null,
    declared,
  );
  if (!connection || action !== ConnectionAction.Allow) {
    return { refused: AllowRefusal.Connection, capability, app } as const;
  }
  if (missingScopes(capability.flow, state.scopes, declared).length > 0) {
    return { refused: AllowRefusal.Scopes, capability, app } as const;
  }
  return { refused: null, capability, app, declared, connection } as const;
}

/** The services of a connection through Composio that an app listing `declared` uses, each with its account. */
function usedServices(
  providerId: string,
  flow: Parameters<typeof composioServicesNeeded>[1],
  declared: readonly string[],
  connection: { accounts: readonly { service: string; account: string }[] },
): { label: string; account: string }[] {
  const needed = composioServicesNeeded(providerId, flow, declared) ?? [];
  return composioServicesOf(providerId).flatMap(({ slug, label }) => {
    const account = connection.accounts.find((each) => each.service === slug);
    return needed.includes(slug) && account
      ? [{ label, account: account.account }]
      : [];
  });
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
      /** The scopes the app lists that the connection holds, as the app wrote them: one the person declined at the provider is left out. */
      scopes: string[];
      /**
       * For a connection made through Composio, the services the app uses
       * with each one's account there: the app can do whatever those
       * accounts allow in Composio. Null for a connection made with the
       * Gateway's client.
       */
      composio: { label: string; account: string }[] | null;
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
    // A connection through Composio holds services, shown below, and the
    // app is allowed for what it lists.
    scopes:
      connection.via === ConnectionVia.Composio
        ? [...declared]
        : declared.filter(
            (scope) =>
              missingScopes(capability.flow, connection.scopes, [scope])
                .length === 0,
          ),
    composio:
      connection.via === ConnectionVia.Composio
        ? usedServices(state.providerId, capability.flow, declared, connection)
        : null,
  };
}
