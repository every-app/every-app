import { createServerFn } from "@tanstack/react-start";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  isOAuthProvider,
  oauthPreset,
  oauthPresetIds,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { PublicError } from "@/server/errors";
import { registersProviders } from "@/server/toolbus/runtime";
import type { EventActor } from "@/server/events/catalogue";
import * as oauth from "@/server/oauth/service";
import {
  addOAuthProviderSchema,
  addScopeSetSchema,
  providerActionSchema,
  removeScopeSetSchema,
  setOAuthClientSchema,
} from "@/schemas/oauth-provider";

// Admin → Providers (docs/design/2026-10-oauth-providers.md section 9): the
// providers this Gateway brokers, and the OAuth ones an owner or admin adds
// from a preset or a custom spec with a client pasted in. Every function is
// scoped to the acting organization by the middleware. A client secret
// travels in exactly once (add, replace) and is never listed back; the
// listing says where the live client comes from (a Worker secret set from
// the terminal, or the one pasted here), never its value.

/**
 * Providers, their clients and their rows are gateway-wide (one client per
 * provider, like a row's key), so on a hosted gateway only the platform's
 * operator may change them: an organization's admin writing here would be
 * writing every tenant's (the same rule hides the provider tools there,
 * `registersProviders`). The listing stays readable.
 */
function requireSelfHosted(): void {
  if (!registersProviders()) {
    throw new PublicError(
      "PROVIDER_HOSTED",
      "On a hosted gateway the platform's operator manages providers and their clients.",
    );
  }
}

/** Who did it, for the events each write emits. */
function actorOf(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): EventActor {
  return {
    kind: "user",
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.name ? { name: user.name } : {}),
  };
}

/** Every provider in the registry: the catalog's and this Gateway's rows. */
export const listProviders = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => ({
    providers: await oauth.listProviders(context.org),
  }));

/** The OAuth providers, with each one's client source, redirect URI and connection count. */
export const listOAuthProviders = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => ({
    providers: await oauth.listOAuthProviders(context.org),
  }));

/** One preset the Add dialog offers: a shipped spec, or a catalog client with a Gateway flow. */
export interface OAuthPresetSummary {
  id: string;
  name: string;
  /** A catalog entry (Google, Microsoft, Slack, Discord): adding it uploads a client only. */
  builtIn: boolean;
  description: string | null;
  hint: string | null;
  /** Where the client is made. */
  console: string;
  scopeSets: { name: string; label: string; access: "read" | "write" }[];
  /** The Gateway settings a terminal sets instead of pasting here. */
  settings: { clientId: string; clientSecret: string | null };
  pkce: boolean;
  hosts: string[];
  /** The redirect URI to register at the provider's console. */
  redirectUri: string;
}

function summarize(
  id: string,
  capability: OAuthClientCapability,
  builtIn: boolean,
): OAuthPresetSummary {
  const sets = capability.scopePolicy?.sets ?? {};
  return {
    id,
    name: capability.label,
    builtIn,
    description: capability.description ?? null,
    hint: capability.hint ?? null,
    console: capability.console,
    scopeSets: Object.entries(sets).map(([name, set]) => ({
      name,
      label: set.label,
      access: set.access,
    })),
    settings: {
      clientId: capability.secrets.clientId,
      clientSecret: capability.secrets.clientSecret ?? null,
    },
    pkce: capability.flow?.pkce ?? true,
    hosts: [...capability.api],
    redirectUri: oauth.redirectUriFor(id),
  };
}

/**
 * The presets the Add dialog offers: the catalog's OAuth clients with a
 * Gateway flow first (built in; adding one uploads a client, no row), then
 * the shipped presets (`OAUTH_PRESETS`: GitHub, Notion, …; adding one
 * writes a row). Static per release, so the page reads it once.
 */
export const listOAuthPresets = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async () => {
    const builtIn = CAPABILITY_IDS.flatMap((id) => {
      const capability = CAPABILITIES[id];
      return isOAuthProvider(capability)
        ? [summarize(id, capability as OAuthClientCapability, true)]
        : [];
    });
    const presets = oauthPresetIds().flatMap((id) => {
      const capability = oauthPreset(id);
      return capability?.mode === "oauth_client"
        ? [summarize(id, capability, false)]
        : [];
    });
    return { presets: [...builtIn, ...presets] };
  });

/** Add an OAuth provider from a preset or a custom spec, with its client when given. */
export const addOAuthProvider = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => addOAuthProviderSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    return oauth.addOAuthProvider(context.org, actorOf(context.user), data);
  });

/** Replace (or first set) a provider's client; the secret is stored sealed and never shown again. */
export const setOAuthClient = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setOAuthClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    return oauth.setOAuthClient(
      context.org,
      actorOf(context.user),
      data.providerId,
      {
        clientId: data.clientId,
        ...(data.clientSecret ? { clientSecret: data.clientSecret } : {}),
      },
    );
  });

/** Forget the pasted client; a Worker secret of the same name, if any, stays live. */
export const removeOAuthClient = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => providerActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    return oauth.removeOAuthClient(
      context.org,
      actorOf(context.user),
      data.providerId,
    );
  });

/** Remove a registered provider, its client and every connection; refused while an app lists it. */
export const removeProvider = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => providerActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    return oauth.removeProvider(
      context.org,
      actorOf(context.user),
      data.providerId,
    );
  });

/**
 * Add a scope set to a built-in OAuth client (Google, Microsoft, Slack):
 * its name, label, access, scopes and the routes on the client's hosts it
 * unlocks. Apps then list it under `scopes` like a built-in set.
 */
export const addScopeSet = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => addScopeSetSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    const { providerId, name, ...set } = data;
    return oauth.addScopeSet(context.org, actorOf(context.user), {
      providerId,
      name,
      spec: set,
    });
  });

/** Remove a scope set an operator added; refused while a deployed app lists it. */
export const removeScopeSet = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => removeScopeSetSchema.parse(data))
  .handler(async ({ data, context }) => {
    requireSelfHosted();
    return oauth.removeScopeSet(context.org, actorOf(context.user), data);
  });
