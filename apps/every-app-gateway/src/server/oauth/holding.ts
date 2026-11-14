/**
 * What a connection to an OAuth provider holds, for either kind of
 * connection (docs/design/2026-11-composio.md). Pure: the proxy reads it
 * on the path of a call, where nothing of the Worker's is loaded.
 */
import {
  ConnectionVia,
  composioMissingScopes,
  missingScopes,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";

/** A connection as the scope rules read it: what its token holds, and what the provider was last asked for. */
interface ScopedConnection {
  scopes: readonly string[];
  /** Null when the last connect was before the Gateway kept it. */
  askedScopes?: readonly string[] | null;
}

/**
 * The scopes an app lists (`declared`) that the provider was never asked
 * for on this connection: neither held nor asked at the last connect. A
 * Reconnect gets these, where the provider grants them. A scope that was
 * asked and isn't held was declined, or the provider didn't grant it: the
 * person's choice, and nothing to prompt for.
 */
export function unaskedScopes(
  flow: OAuthClientCapability["flow"],
  connection: ScopedConnection,
  declared: readonly string[],
): string[] {
  return missingScopes(
    flow,
    [...connection.scopes, ...(connection.askedScopes ?? [])],
    declared,
  );
}

/** What a connection holds, as the rules that read it need it. */
export interface ConnectionHolding extends ScopedConnection {
  via: ConnectionVia;
  /** On a connection through Composio, its services. */
  accounts: readonly { service: string }[];
}

/** An OAuth provider as those rules read it: its id, its flow's scope rules, and how it is served now. */
export interface ServedProvider {
  id: string;
  flow: OAuthClientCapability["flow"];
  /** With the Gateway's client, through Composio, or null: not set up. */
  via: ConnectionVia | null;
}

/**
 * The scopes of `declared` a connection has to be made again for. A
 * connection made with the Gateway's client lacks the ones the provider
 * was never asked for ({@link unaskedScopes}): one that was asked and
 * isn't held was declined, and is nothing to prompt for. One made through
 * Composio holds services, each with an account
 * (docs/design/2026-11-composio.md), and lacks the scopes whose service
 * has none. The one answer the connect link, a call, the status route,
 * the Allow form and Reconnect all read.
 */
export function connectionLacks(
  provider: Pick<ServedProvider, "id" | "flow">,
  connection: ConnectionHolding,
  declared: readonly string[],
): string[] {
  return connection.via === ConnectionVia.Composio
    ? composioMissingScopes(
        provider.id,
        provider.flow,
        connection.accounts.map((each) => each.service),
        declared,
      )
    : unaskedScopes(provider.flow, connection, declared);
}
