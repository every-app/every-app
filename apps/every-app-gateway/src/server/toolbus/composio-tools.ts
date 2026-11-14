/**
 * The handlers behind the `everyapp_provider_composio*` tools on the
 * gateway's own /mcp (docs/design/2026-11-composio.md), run like the
 * workspace tools (workspace-tools.ts spreads them into its handler map)
 * for a resolved caller, through the service Your connections → Accounts
 * calls (server/composio/service.ts). A caller acts only on their own
 * link, whatever their role. No answer carries the key or the sign-in id;
 * the sign-in's page is answered once, by the start, to the caller who
 * started it. The service's refusals are `PublicError`s, which the runner
 * answers as `CODE: message`.
 */
import type { JsonObject } from "@every-app/toolbus";
import { ComposioLinkState } from "@/schemas/composio";
import {
  composioStatus,
  finishComposioLink,
  startComposioLink,
  unlinkComposio,
  type ComposioStatus,
} from "@/server/composio/service";
import type { OrgContext } from "@/server/organization/orgContext";

type Handler = (ctx: OrgContext) => Promise<JsonObject>;

/** The link as a tool answers it: never the key. */
function shown(status: ComposioStatus): JsonObject {
  return {
    composio: status.composio,
    linked: status.linked,
    account: status.account,
    providers:
      status.providers?.map((provider) => ({
        provider: provider.providerId,
        providerName: provider.providerName,
        services: provider.services.map((service) => ({
          name: service.label,
          accounts: [...service.accounts],
        })),
        connected: provider.connected,
      })) ?? null,
  };
}

/** What to do with a link, by what it holds. */
function nextOf(status: ComposioStatus): string {
  if (status.composio === "off") {
    return "Composio is off for this organization. An owner or admin turns it on with everyapp_workspace_composio.";
  }
  if (!status.linked) {
    return "Composio isn't linked. everyapp_provider_composio_link starts linking; the person approves a sign-in at Composio.";
  }
  if (status.providers === null) {
    return "Composio didn't answer, so what is in this Composio isn't known. Call again.";
  }
  if (status.providers.length === 0) {
    return "Nothing EveryApp supports is connected in this Composio yet. The person connects a service in Composio; nothing here connects one there.";
  }
  return "Linking added no connection. An account here becomes the person's connection when an app asks for it and they say yes, on the Gateway's page in a browser: they open the app and select Connect. everyapp_provider_connections lists the connections made, with `via`.";
}

export const COMPOSIO_HANDLERS: Record<string, Handler> = {
  async provider_composio(ctx) {
    const status = await composioStatus(ctx, { list: true });
    return { ...shown(status), next: nextOf(status) };
  },

  async provider_composio_link(ctx) {
    const { url, expiresAt } = await startComposioLink(ctx);
    return {
      url,
      expiresAt: new Date(expiresAt).toISOString(),
      next: "Give this link to the person this connection acts as, to open and approve in their browser, and to nobody else. Then call everyapp_provider_composio_link_finish every couple of seconds until it answers linked or expired.",
    };
  },

  async provider_composio_link_finish(ctx) {
    const result = await finishComposioLink(ctx);
    switch (result.state) {
      case ComposioLinkState.Waiting:
        return {
          state: result.state,
          next: "Not approved yet. Call everyapp_provider_composio_link_finish again in a couple of seconds.",
        };
      case ComposioLinkState.Linked:
        return {
          state: result.state,
          ...shown(result.status),
          next: nextOf(result.status),
        };
      case ComposioLinkState.Expired:
        return {
          state: result.state,
          next: "The sign-in ran out, or none was started. everyapp_provider_composio_link starts another.",
        };
    }
  },

  async provider_composio_unlink(ctx) {
    const { removed } = await unlinkComposio(ctx);
    return {
      removed,
      next: removed
        ? "Every connection this person made through Composio is gone, so their apps stopped using those accounts. The key stays valid at Composio until the person revokes it there."
        : "Composio wasn't linked.",
    };
  },
};
