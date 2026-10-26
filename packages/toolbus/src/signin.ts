/**
 * The sign-in provider tools: Manage workspace → Sign-in and `everyapp
 * signin list|show` on the gateway's own /mcp, under `everyapp_signin_*`,
 * beside the workspace and provider tools and run the same way (kind
 * `host`, `ToolBusDeps.workspace`). The handlers are the gateway's
 * (apps/every-app-gateway/src/server/toolbus/signin-tools.ts).
 *
 * Both read, for owners and admins, in either deployment mode (a sign-in
 * provider can be on in both, so neither `needs` anything beyond the host).
 * They report each provider's state, which of its settings are set (by
 * name, never a value), the redirect URL to register and the command that
 * sets it up.
 *
 * There is deliberately no tool for `signin add` or `signin remove`: the
 * settings are Worker secrets the Gateway can't write to itself, and a
 * tool that could would let a stolen agent token add a way in (threat
 * model B10, `signin.tools.read-state-only`).
 */
import { SIGN_IN_PROVIDER_IDS } from "@every-app/sdk/internal";
import type { WorkspaceToolDefinition } from "./workspace";

/** The sign-in provider tools, in the order tools/list shows them, after the provider tools. */
export const SIGNIN_TOOLS: readonly WorkspaceToolDefinition[] = [
  {
    risk: "read",
    minRole: "admin",
    name: "signin_list",
    title: "List the sign-in providers",
    description:
      "List the ways people can sign in to this Gateway beside their password (Manage workspace → Sign-in): every sign-in provider (google, microsoft, github, apple, cloudflare, oidc) with its status (on; off; incomplete, which means needs setup: some settings are set and the provider stays off until the rest are), the settings it reads with whether each is set (never a value), the redirect URL to register at the provider, and the command that sets it up from a terminal (`pnpm everyapp signin add <id>`); also whether password sign-in is on, whether Cloudflare Access sign-in is on, and whether Access is in front of the Gateway (`outerRing`; then Access signs people in and the providers matter only without it). Nothing here changes a setting: they are Worker secrets, set from the terminal. Owners and admins.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    risk: "read",
    minRole: "admin",
    name: "signin_show",
    title: "Show one sign-in provider",
    description:
      "Show one sign-in provider as `everyapp signin show <id>` does: its status, each setting's name, what to paste there and whether it is set (never a value), the redirect URL to register, where the OAuth app is made and what it is called there, the scopes asked for, which claim becomes the email, the caveats, the setup guide in the everyapp skill, the command that sets it up from a terminal, and for one that needs setup what is wrong. Owners and admins.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The provider's id, as everyapp_signin_list lists it.",
          enum: [...SIGN_IN_PROVIDER_IDS],
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
