/**
 * Using an account from a person's Composio in an app
 * (docs/design/2026-11-composio.md): what the Gateway's Composio page
 * shows (routes/oauth/composio.tsx), and what its form's handler
 * (server/oauth/flow.ts) checks again. Read from the one-use `composio`
 * state the connect started, which stays in place until the form spends
 * it. The person's accounts are read from Composio each time: nothing is
 * cached.
 */
import {
  ConnectionVia,
  composioServicesOf,
  composioServiceUrl,
  missingScopes,
} from "@every-app/sdk/internal";
import { ComposioPageStep } from "@/schemas/composio";
import {
  declaredScopes,
  declaredWhy,
  memberAppByRow,
} from "@/server/oauth/appAccess";
import type { Fetch } from "@/server/oauth/tokens";
import type { OrgContext } from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import {
  composioAccounts,
  providerServing,
  servicesThroughComposio,
} from "./link";

/** Why the Composio page, or its form, can't go ahead. */
export enum ComposioRefusal {
  /** The provider is gone, or the app no longer lists it or opens for the person. */
  App = "app",
  /** The provider isn't served through Composio any more: it has a client now, Composio is off, or the app lists a scope no service covers. */
  Served = "served",
  /** The app lists more than the state (what the page showed). */
  Scopes = "scopes",
}

/**
 * What the Composio page and its form both check about a `composio`
 * state, in order: the provider and the app, that the provider is served
 * through Composio for what the app lists, and that the app lists no more
 * than the state holds. `needed` is the services the app needs there.
 */
export async function composioCheck(
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
    return { refused: ComposioRefusal.App } as const;
  }
  const serving = await providerServing({
    organizationId: person.org.orgId,
    providerId: state.providerId,
    capability,
    lookup: registry,
  });
  const needed =
    serving.via === ConnectionVia.Composio
      ? servicesThroughComposio(
          app,
          state.providerId,
          capability.flow,
          declared,
        )
      : null;
  if (needed === null) {
    return { refused: ComposioRefusal.Served, capability, app } as const;
  }
  if (missingScopes(capability.flow, state.scopes, declared).length > 0) {
    return { refused: ComposioRefusal.Scopes, capability, app } as const;
  }
  return { refused: null, capability, app, declared, needed } as const;
}

/** One service the app needs, with the accounts the person has for it in Composio. */
interface ComposioPageService {
  slug: string;
  /** What a person calls it ("Gmail"). */
  label: string;
  /** The accounts to choose from: Composio's id for each, and its name. */
  accounts: { id: string; account: string }[];
  /** The account chosen until the person picks another: the one their connection uses now, else the first. */
  chosen: string;
}

/** What every step of the page shows. */
interface ComposioPageBase {
  ok: true;
  /** The one-use state the form posts back. */
  state: string;
  /** Where the form posts: `/connect/<provider>/composio`. */
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
  /** What the app says it does with the account, when its manifest says. */
  why: string | null;
}

export type ComposioPageContext =
  | { ok: false; message: string }
  | (ComposioPageBase & { step: ComposioPageStep.Link })
  | (ComposioPageBase & {
      step: ComposioPageStep.Missing;
      /** The services the app needs that aren't connected in their Composio, each with its page there. */
      missing: { slug: string; label: string; url: string }[];
    })
  | (ComposioPageBase & {
      step: ComposioPageStep.Allow;
      services: ComposioPageService[];
    });

const GONE: ComposioPageContext = {
  ok: false,
  message: "This page was used already or expired. Open the app again.",
};

export async function buildComposioContext(
  person: { id: string; email: string; org: OrgContext },
  stateParam: string,
  options: { now?: number; fetchUpstream?: Fetch } = {},
): Promise<ComposioPageContext> {
  const state = await OAuthStateRepository.peek(
    stateParam,
    new Date(options.now ?? Date.now()),
  );
  if (
    !state ||
    state.purpose !== OAuthStatePurpose.Composio ||
    state.userId !== person.id ||
    state.organizationId !== person.org.orgId
  ) {
    return GONE;
  }
  const check = await composioCheck(person, state);
  if (check.refused === ComposioRefusal.Served) {
    return {
      ok: false,
      message: `How ${check.capability.label} is set up on this Gateway changed since this page opened. Open ${check.app.name} and connect again.`,
    };
  }
  // The state holds the scopes the app listed when the connect started;
  // the form's handler allows no more than those. An app that lists more
  // by now starts again.
  if (check.refused !== null) return GONE;
  const { capability, app, needed } = check;
  const icon = app.manifest?.["icon"];
  const base: ComposioPageBase = {
    ok: true,
    state: state.state,
    action: `/connect/${encodeURIComponent(state.providerId)}/composio`,
    email: person.email,
    provider: { id: state.providerId, name: capability.label },
    app: {
      id: app.slug,
      name: app.name,
      hostname: app.hostname,
      status: app.status,
      icon: typeof icon === "string" ? icon : null,
    },
    why: declaredWhy(app.manifest, state.providerId),
  };
  const key = {
    organizationId: person.org.orgId,
    userId: person.id,
  };
  const read = await composioAccounts(key, options.fetchUpstream);
  if (!read.linked) return { ...base, step: ComposioPageStep.Link };
  if (read.accounts === null) {
    return { ok: false, message: "Composio could not be reached. Try again." };
  }
  const listed = read.accounts;
  const existing = await ProviderConnectionRepository.find({
    ...key,
    providerId: state.providerId,
  });
  const services = composioServicesOf(state.providerId)
    .filter(({ slug }) => needed.includes(slug))
    .map(({ slug, label }) => {
      const accounts = listed
        .filter((each) => each.slug === slug)
        .map(({ id, account }) => ({ id, account }));
      const used = existing?.accounts.find((each) => each.service === slug);
      return {
        slug,
        label,
        accounts,
        chosen:
          accounts.find((each) => each.id === used?.id)?.id ??
          accounts[0]?.id ??
          "",
      };
    });
  const missing = services.filter((each) => each.accounts.length === 0);
  if (missing.length > 0) {
    return {
      ...base,
      step: ComposioPageStep.Missing,
      missing: missing.map(({ slug, label }) => ({
        slug,
        label,
        url: composioServiceUrl(slug),
      })),
    };
  }
  return {
    ...base,
    step: ComposioPageStep.Allow,
    services,
  };
}
