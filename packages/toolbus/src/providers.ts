/**
 * The provider tools: the API provider registry
 * (docs/design/2026-10-provider-registry.md, section 8) and the OAuth
 * providers people connect their accounts to
 * (docs/design/2026-10-oauth-providers.md, section 9) on the gateway's own
 * /mcp, under `everyapp_provider_*`, beside the workspace tools and run
 * the same way (kind `host`, `ToolBusDeps.workspace`).
 *
 * `everyapp_provider_list` reads the catalog, this gateway's rows and the
 * OAuth presets for every member: what an agent needs to write a
 * manifest's `capabilities` and to tell a person which key to set or
 * where to connect. `everyapp_provider_add` and `everyapp_provider_remove`
 * write the rows for owners and admins, and only where the host registers
 * providers (`WorkspaceHost.providers`: a self-hosted gateway; a hosted
 * one hides them, Unknown tool on call). `add` takes the spec object or a
 * preset id alone, never a URL to fetch and never a replace of a row that
 * is there; `remove` takes the id alone and refuses a row whose key is
 * bound, a row an app lists and a built-in. No value passes through
 * either: a spec names its secrets, the key or client is set from the
 * terminal (`everyapp secret set`) or pasted under Admin → Providers.
 *
 * `everyapp_provider_connections` lists the caller's own connections to
 * OAuth providers (every member) or the whole organization's (owners and
 * admins, `all: true`); `everyapp_provider_disconnect` removes the
 * caller's own, or any for owners and admins, revoking the grant at the
 * provider where the preset knows how. Neither carries a token.
 */
import type { WorkspaceToolDefinition } from "./workspace";

/** A provider id as the spec rule has it: `^[a-z][a-z0-9-]{1,39}$`, spelled without a regex here. */
const PROVIDER_ID_MAX = 40;

/**
 * The provider tools, in the order tools/list shows them, after the
 * workspace tools. `needs: "providers"` marks the two that write rows.
 */
export const PROVIDER_TOOLS: readonly WorkspaceToolDefinition[] = [
  {
    risk: "read",
    minRole: "member",
    name: "provider_list",
    title: "List the API providers",
    description:
      'List the API providers this Gateway brokers: the built-in catalog and the ones registered on this Gateway, each with its id (what an app lists under `capabilities`), name, kind (api_key, ai, oauth_client), where the key goes, hosts, docs link, hint, and the Gateway settings it reads; an OAuth provider also with its flow, the redirect URI to register at its console, its scope sets, where its client comes from and how many accounts are connected. Also `presets`: the OAuth presets `everyapp_provider_add` takes by id (`{ preset: "github-oauth" }`). For owners and admins, whether each setting is set. Never a value. Any member.',
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "admin",
    needs: "providers",
    name: "provider_add",
    title: "Register an API provider",
    description:
      "Register a provider on this Gateway: an API provider from its spec `{ id, name, docs, hosts, auth: { kind: bearer | header | query | basic, secret: SETTING_NAME, … }, hint?, secrets?, access?, writeMethods?, accountWidePaths?, data?, smoke?, cost?, rate? }`, an OAuth provider from a spec with `auth: { kind: oauth2-user, authorizeUrl, tokenUrl, clientId: SETTING_NAME, clientSecret?: SETTING_NAME, … }` and `scopeSets`, or an OAuth preset by id (`{ preset: \"github-oauth\" }`; `everyapp_provider_list` names them; a built-in client such as `google-workspace` writes no row). A spec names its settings and never carries a value: a client id or secret is set from the terminal (`everyapp secret set NAME`) or pasted under Admin → Providers, never through a tool. The id must not be a built-in provider's, its settings must start with its own id (`STRIPE_` for `stripe`) and be nobody else's, and its hosts must be the provider's own public https hosts. An id that is registered already is refused: this tool never replaces a row (`everyapp provider add --replace` from the terminal does). For an OAuth provider the answer carries the redirect URI to register at the provider's console and where people connect. Owners and admins, on a self-hosted Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description:
            "The provider spec object (never a URL). Its fields are checked by the same parser as `everyapp provider add`; a problem names the field. One of spec or preset.",
        },
        preset: {
          type: "string",
          description:
            "An OAuth preset id from `everyapp_provider_list`'s `presets` (github-oauth, notion-oauth, …), or a built-in client's id (google-workspace, slack, microsoft-365, discord). One of spec or preset.",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
      },
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "admin",
    needs: "providers",
    name: "provider_remove",
    title: "Remove a registered API provider",
    description:
      "Remove an API provider registered on this Gateway, by its id. Refused for a built-in provider, for a row whose key is set (remove it from the terminal: `everyapp provider remove <id>`, then `everyapp secret unset`), and for a row an app's deployed manifest lists under `capabilities` (naming the apps). The Gateway settings the row named stay until `everyapp secret unset`. Owners and admins, on a self-hosted Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The provider's id, as everyapp_provider_list lists it (a registered one, never a built-in).",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    risk: "read",
    minRole: "member",
    name: "provider_connections",
    title: "List connected accounts",
    description:
      "List the accounts connected to OAuth providers on this Gateway: the caller's own (any member), or with `all: true` every connection in the organization, people's and the organization's own (owners and admins). Each with the provider, whose it is, the account's label at the provider, the scope sets granted, its status (active, or expired: the provider refused a refresh and the person connects again) and when it was last used. Never a token. People connect in the browser at `<gateway>/connect/<provider>`; there is no tool for that.",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description:
            "Every connection in the organization, not only the caller's (owners and admins).",
        },
        provider: {
          type: "string",
          description: "One provider's connections only, by id.",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
      },
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "member",
    name: "provider_disconnect",
    title: "Disconnect an account",
    description:
      "Remove a connection to an OAuth provider: the caller's own (any member), or for owners and admins another person's (`user`: their email or user id) or the organization's own (`account: organization`). The Gateway drops the tokens it held and revokes the grant at the provider where the preset knows how (`revoked` says whether it did); apps get `integration_not_connected` until the person connects again in the browser.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The OAuth provider's id, as everyapp_provider_list lists it.",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
        account: {
          type: "string",
          enum: ["user", "organization"],
          description:
            "A person's connection (default) or the organization's own (owners and admins).",
        },
        user: {
          type: "string",
          description:
            "Whose connection, by email or user id (owners and admins; default: the caller's own).",
          minLength: 1,
          maxLength: 320,
        },
      },
      required: ["provider"],
      additionalProperties: false,
    },
  },
];
