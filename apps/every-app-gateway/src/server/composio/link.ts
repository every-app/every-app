/**
 * A person's Composio link as the rest of the Gateway reads it
 * (docs/design/2026-11-composio.md): how a provider is served in an
 * organization, what a call for a link is made with, the accounts in a
 * person's Composio, and a link's removal. The key leaves this module
 * only inside the credentials a call is made with.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  ConnectionVia,
  composioServiceSlugs,
  composioServicesNeeded,
  oauthServing,
  remoteMcpOf,
  type CapabilityLookup,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import {
  resolveOAuthClient,
  type ResolvedOAuthClient,
} from "@/server/oauth/client";
import type { Fetch } from "@/server/oauth/tokens";
import {
  ComposioLinkRepository as Links,
  type ComposioLink,
} from "@/server/repositories/ComposioLinkRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import {
  ProviderConnectionRepository as Connections,
  type ProviderConnection,
} from "@/server/repositories/ProviderConnectionRepository";
import {
  ComposioFailure,
  composioClient,
  type ComposioCredentials,
  type ConnectedAccount,
} from "./client";

export interface ComposioPerson {
  organizationId: string;
  userId: string;
}

/** Why a link was removed. */
export enum ComposioUnlinkReason {
  /** The person unlinked. */
  Person = "person",
  /** Composio refused the key. */
  KeyRefused = "key_refused",
  /** The sealed key no longer opens. */
  KeyLost = "key_lost",
}

/** How a provider is served in an organization, with the Gateway's client when it holds one. */
interface ProviderServing {
  /** With the client, through Composio, or null: not set up. */
  via: ConnectionVia | null;
  client: ResolvedOAuthClient | null;
}

/**
 * How an OAuth provider is served in an organization (the SDK's
 * `oauthServing`): with the Gateway's client whenever it holds one, else
 * through Composio when the organization turned it on and Composio serves
 * the provider.
 */
export async function providerServing(input: {
  organizationId: string;
  providerId: string;
  capability: OAuthClientCapability;
  lookup?: CapabilityLookup;
}): Promise<ProviderServing> {
  const client = await resolveOAuthClient({
    id: input.providerId,
    capability: input.capability,
    env: env as never,
    ...(input.lookup ? { lookup: input.lookup } : {}),
  });
  const via = oauthServing({
    providerId: input.providerId,
    clientHeld: client !== null,
    composioOn:
      client === null &&
      (await OrgSettingsRepository.isComposioOn(input.organizationId)),
  });
  return { via, client };
}

/**
 * The services an app needs at Composio for the scopes it lists, or null
 * when it can't be served through Composio (the SDK's
 * `composioServicesNeeded`). A remote MCP app never is: its server is
 * reached with a token the Gateway holds, so its provider needs a client.
 */
export function servicesThroughComposio(
  app: { manifest: Record<string, unknown> | null },
  providerId: string,
  flow: OAuthClientCapability["flow"],
  declared: readonly string[],
): string[] | null {
  if (app.manifest && remoteMcpOf(app.manifest)) return null;
  return composioServicesNeeded(providerId, flow, declared);
}

/** What a call for the link is made with; null when its key no longer opens. */
export async function composioCredentials(
  link: ComposioLink,
): Promise<ComposioCredentials | null> {
  const key = await Links.readKey(link, env as never);
  if (key === null) return null;
  return {
    key,
    orgId: link.composioOrgId,
    projectId: link.composioProjectId,
    userId: link.composioUserId,
  };
}

/**
 * Remove a person's link, and any sign-in waiting. When they unlinked,
 * every connection they made through it goes too, with its access. When
 * Composio refused the key (or it no longer opens), those connections
 * turn expired and keep their access rows: linking again and Reconnect
 * brings them back. Nothing is called at Composio. The connections that
 * turned expired.
 */
export async function dropComposioLink(
  person: ComposioPerson,
  reason: ComposioUnlinkReason,
): Promise<{ removed: boolean; expired: ProviderConnection[] }> {
  let expired: ProviderConnection[] = [];
  let connections = 0;
  if (reason === ComposioUnlinkReason.Person) {
    connections = await Connections.removeComposio(
      person.organizationId,
      person.userId,
    );
  } else {
    expired = await Connections.expireComposio(
      person.organizationId,
      person.userId,
    );
  }
  const unlinked = await Links.remove(person);
  if (unlinked) {
    logEvent(
      "composio.unlinked",
      { org: person.organizationId, user_id: person.userId, reason },
      reason === ComposioUnlinkReason.Person ? "log" : "warn",
    );
  }
  // Connections left behind by a key Composio refused count as removed.
  return { removed: unlinked || connections > 0, expired };
}

/** What reading a person's Composio answers. */
type ComposioAccounts =
  | { linked: false }
  | { linked: true; link: ComposioLink; accounts: ConnectedAccount[] }
  /** Composio didn't answer: the link stands, and nothing is known of its accounts. */
  | { linked: true; link: ComposioLink; accounts: null };

/**
 * The accounts in a person's Composio for the services EveryApp supports,
 * read from Composio now: nothing is cached. A refused key, or one that
 * no longer opens, removes the link first.
 */
export async function composioAccounts(
  person: ComposioPerson,
  fetchUpstream: Fetch = (request) => fetch(request),
): Promise<ComposioAccounts> {
  const link = await Links.find(person);
  if (!link) return { linked: false };
  const credentials = await composioCredentials(link);
  if (!credentials) {
    await dropComposioLink(person, ComposioUnlinkReason.KeyLost);
    return { linked: false };
  }
  const listed = await composioClient(fetchUpstream).listAccounts(
    credentials,
    composioServiceSlugs(),
  );
  if (listed.ok) return { linked: true, link, accounts: listed.value };
  if (listed.failure === ComposioFailure.KeyRefused) {
    await dropComposioLink(person, ComposioUnlinkReason.KeyRefused);
    return { linked: false };
  }
  logEvent(
    "composio.accounts_unavailable",
    { org: person.organizationId, user_id: person.userId },
    "warn",
  );
  return { linked: true, link, accounts: null };
}
