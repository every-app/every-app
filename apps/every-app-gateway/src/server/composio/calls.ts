/**
 * The Composio side of an app's call to a provider
 * (docs/design/2026-11-composio.md), as a port: the gateway's own over D1
 * and Composio here, an in-memory one in tests. It hands out a provider's
 * answer and nothing about the key.
 *
 * A call goes through a session at Composio that was opened for exactly
 * the accounts on the person's connections, so it is sent with the
 * account the connection names and no other. The session is kept on the
 * person's link with the accounts it was opened for; a call whose
 * connections name other accounts by now opens another.
 */
import { composioServiceSlugs } from "@every-app/sdk/internal";
import type { Fetch } from "@/server/oauth/tokens";
import { ComposioLinkRepository as Links } from "@/server/repositories/ComposioLinkRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { ProviderConnectionRepository as Connections } from "@/server/repositories/ProviderConnectionRepository";
import {
  ComposioBodyKind,
  ComposioFailure,
  composioClient,
  type ComposioProxyRequest,
} from "./client";
import {
  ComposioUnlinkReason,
  composioCredentials,
  dropComposioLink,
} from "./link";

/** A provider's body as it reaches the proxy: a binary one already open. */
type ComposioCallBody =
  | { kind: ComposioBodyKind.Json; value: unknown }
  | { kind: ComposioBodyKind.Text; text: string }
  | {
      kind: ComposioBodyKind.Binary;
      contentType: string;
      stream: ReadableStream<Uint8Array> | null;
    };

/** The provider's answer to one call. */
export interface ComposioCallAnswer {
  status: number;
  /** The provider's headers, lower-case names. */
  headers: Record<string, string>;
  body: ComposioCallBody;
}

export type ComposioSent =
  | { ok: true; value: ComposioCallAnswer }
  | {
      ok: false;
      failure: ComposioFailure;
      /** This call is the one that turned the connection expired (the caller says so once). */
      expired: boolean;
    };

export interface ComposioCallPort {
  /** Whether the organization turned Composio on. */
  on(organizationId: string): Promise<boolean>;
  /**
   * One provider request through the person's link, sent with the account
   * the connection names for the service. A refused key removes the link
   * and turns the person's connections through it expired; an account
   * that is gone turns this connection expired. Both before they are
   * reported.
   */
  send(input: {
    organizationId: string;
    /** The connection the call uses: a row made through Composio. */
    connection: { id: string; userId: string };
    /** The service that owns the URL, and Composio's id for the account the connection names for it. */
    account: { service: string; id: string };
    request: ComposioProxyRequest;
  }): Promise<ComposioSent>;
}

/** The accounts a session is opened for, as one string to compare. */
function fingerprint(accounts: Readonly<Record<string, string>>): string {
  return Object.entries(accounts)
    .map(([service, id]) => `${service}:${id}`)
    .sort()
    .join(",");
}

/** The gateway's own port over D1 and Composio. */
export function gatewayComposioCalls(options: {
  fetchUpstream: Fetch;
}): ComposioCallPort {
  const client = composioClient(options.fetchUpstream);
  return {
    on: (organizationId) => OrgSettingsRepository.isComposioOn(organizationId),

    async send({ organizationId, connection, account, request }) {
      const person = { organizationId, userId: connection.userId };
      const failed = (failure: ComposioFailure, expired = false) => ({
        ok: false as const,
        failure,
        expired,
      });
      /** The key can't be used: the link goes, and the person's connections through it turn expired. */
      const keyRefused = async (reason: ComposioUnlinkReason) => {
        const dropped = await dropComposioLink(person, reason);
        return failed(
          ComposioFailure.KeyRefused,
          dropped.expired.some((each) => each.id === connection.id),
        );
      };
      /** This connection's account is gone from the person's Composio. */
      const accountGone = async () =>
        failed(
          ComposioFailure.NotConnected,
          await Connections.markExpired(connection.id),
        );

      const link = await Links.find(person);
      if (!link) return keyRefused(ComposioUnlinkReason.KeyLost);
      const credentials = await composioCredentials(link);
      if (!credentials) return keyRefused(ComposioUnlinkReason.KeyLost);

      /** For each service, the account the person's active connections through Composio name. */
      const pinned = async () => {
        const accounts: Record<string, string> = {};
        const rows = await Connections.listComposio(
          organizationId,
          connection.userId,
        );
        for (const row of rows) {
          if (row.status !== "active") continue;
          for (const each of row.accounts) accounts[each.service] = each.id;
        }
        return { rows, accounts };
      };
      let { rows, accounts } = await pinned();
      // The connection changed under the call: the app's next one reads it again.
      if (accounts[account.service] !== account.id) {
        return failed(ComposioFailure.NotConnected);
      }

      /**
       * A session for `accounts`, kept on the link. Composio opens none
       * for an account that is gone, so a refusal reads the person's
       * accounts once: every connection that names one that is gone turns
       * expired, and the session is opened for the rest.
       */
      const open = async (): Promise<
        { ok: true; value: string } | ReturnType<typeof failed>
      > => {
        let opened = await client.openSession(credentials, accounts);
        if (!opened.ok && opened.failure !== ComposioFailure.KeyRefused) {
          const listed = await client.listAccounts(
            credentials,
            composioServiceSlugs(),
          );
          if (!listed.ok) return failed(listed.failure);
          const gone = rows.filter(
            (row) =>
              row.status === "active" &&
              !row.accounts.every((each) =>
                listed.value.some(
                  (found) =>
                    found.id === each.id && found.slug === each.service,
                ),
              ),
          );
          if (gone.length === 0) return failed(opened.failure);
          let mine = false;
          for (const row of gone) {
            const first = await Connections.markExpired(row.id);
            if (row.id === connection.id) mine = first;
          }
          if (gone.some((row) => row.id === connection.id)) {
            return failed(ComposioFailure.NotConnected, mine);
          }
          ({ rows, accounts } = await pinned());
          opened = await client.openSession(credentials, accounts);
        }
        if (!opened.ok) return failed(opened.failure);
        await Links.storeSession(person, {
          id: opened.value,
          accounts: fingerprint(accounts),
        });
        return opened;
      };

      let sessionId =
        link.sessionAccounts === fingerprint(accounts) ? link.sessionId : null;
      if (sessionId === null) {
        const opened = await open();
        if (!opened.ok) {
          return opened.failure === ComposioFailure.KeyRefused
            ? keyRefused(ComposioUnlinkReason.KeyRefused)
            : opened;
        }
        sessionId = opened.value;
      }
      let executed = await client.proxyExecute(credentials, sessionId, request);
      if (!executed.ok && executed.failure === ComposioFailure.SessionGone) {
        const opened = await open();
        if (!opened.ok) {
          return opened.failure === ComposioFailure.KeyRefused
            ? keyRefused(ComposioUnlinkReason.KeyRefused)
            : opened;
        }
        executed = await client.proxyExecute(
          credentials,
          opened.value,
          request,
        );
      }
      if (!executed.ok) {
        switch (executed.failure) {
          case ComposioFailure.KeyRefused:
            return keyRefused(ComposioUnlinkReason.KeyRefused);
          case ComposioFailure.NotConnected:
            return accountGone();
          default:
            return failed(executed.failure);
        }
      }

      const { status, headers, body } = executed.value;
      if (body.kind !== ComposioBodyKind.Binary) {
        return { ok: true, value: { status, headers, body } };
      }
      const stream = await client.download(body);
      if (!stream.ok) return failed(stream.failure);
      return {
        ok: true,
        value: {
          status,
          headers,
          body: {
            kind: ComposioBodyKind.Binary,
            contentType: body.contentType,
            stream: stream.value,
          },
        },
      };
    },
  };
}
