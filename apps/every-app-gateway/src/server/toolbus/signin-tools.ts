/**
 * The handlers behind the sign-in provider tools on the gateway's own /mcp
 * (`everyapp_signin_list`, `everyapp_signin_show`; definitions in
 * packages/toolbus/src/signin.ts), run like the workspace tools
 * (workspace-tools.ts spreads them into its handler map) for a resolved
 * caller whose role the ToolBus has already checked (owners and admins).
 *
 * Both answer from the same listing as Manage workspace → Sign-in
 * (server/sign-in-providers.ts): each provider's state and which of its
 * settings are set, by name, never a value. Nothing here writes: the
 * settings are Worker secrets the Gateway can't write to itself, and no
 * tool adds or removes a provider, so a stolen agent token can't add a way
 * in (threat model B10, `signin.tools.read-state-only`).
 */
import { SIGN_IN_PROVIDER_IDS } from "@every-app/sdk/internal";
import type { JsonObject } from "@every-app/toolbus";
import type { OrgContext } from "@/server/organization/orgContext";
import {
  listSignInProviders,
  showSignInProvider,
} from "@/server/sign-in-providers";

type Handler = (ctx: OrgContext, args: JsonObject) => Promise<JsonObject>;

/** What the operator does next, from a terminal; never through a tool. */
const NEXT =
  "Sign-in settings are Worker secrets: set one up from a terminal with the Gateway's Cloudflare login, `pnpm everyapp signin add <id>` (it asks for each setting), after registering the redirect URL at the provider. No tool changes them.";

export const SIGNIN_HANDLERS: Record<string, Handler> = {
  async signin_list() {
    const listing = await listSignInProviders();
    return { ...listing, next: NEXT } as unknown as JsonObject;
  },

  async signin_show(_ctx, args) {
    const id = typeof args["id"] === "string" ? args["id"] : "";
    const provider = await showSignInProvider(id);
    if (!provider) {
      return {
        error: `SIGNIN_PROVIDER_UNKNOWN: no sign-in provider ${JSON.stringify(id)}; the ids are ${SIGN_IN_PROVIDER_IDS.join(", ")}`,
      };
    }
    return {
      provider,
      ...(provider.status === "on" ? {} : { next: NEXT }),
    } as unknown as JsonObject;
  },
};
