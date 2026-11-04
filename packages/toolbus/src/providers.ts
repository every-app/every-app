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
 * bound, a row an app lists and an id with no row. No value passes through
 * either: a spec names its secrets, the key or client is set from the
 * terminal (`everyapp secret set`) or pasted under Admin → Providers.
 *
 * `everyapp_provider_connections` lists the caller's own connections to
 * OAuth providers (every member) or the whole organization's (owners and
 * admins, `all: true`), each one person's in one app;
 * `everyapp_provider_disconnect` removes the caller's own, or any for
 * owners and admins, revoking the grant at the provider where the spec
 * knows how. Neither carries a token.
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
      'List the API providers this Gateway brokers: the built-in catalog and the ones registered on this Gateway, each with its id (what an app lists under `capabilities`), name, kind (api_key, ai, oauth_client), where the key goes, hosts, docs link, hint, and the Gateway settings it reads; an OAuth provider also with the redirect URI to register at its console, where its client comes from and how many accounts are connected. Scopes belong to each app: an app lists the scope strings the provider defines under `capabilities.<id>.scopes`. Also `presets`: the OAuth presets `everyapp_provider_add` takes by id (`{ preset: "github-oauth" }`). For owners and admins, whether each setting is set. Never a value. Any member.',
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
      "Register a provider on this Gateway: an API provider from its spec `{ id, name, docs, hosts, auth: { kind: bearer | header | query | basic, secret: SETTING_NAME, … }, hint?, secrets?, access?, writeMethods?, accountWidePaths?, data?, smoke?, cost?, rate? }`, an OAuth provider from a spec with `auth: { kind: oauth2-user, authorizeUrl, tokenUrl, clientId: SETTING_NAME, clientSecret?: SETTING_NAME, … }` (no scopes: each app lists its own), or an OAuth preset by id (`{ preset: \"google-workspace\" }`; `everyapp_provider_list` names them; deploying an app that lists a preset registers it too). A spec names its settings and never carries a value: a client id or secret is set from the terminal (`everyapp secret set NAME`) or pasted under Admin → Providers, never through a tool. The id must not be a built-in provider's, its settings must start with its own id (`STRIPE_` for `stripe`) and be nobody else's, and its hosts must be the provider's own public https hosts. A spec whose id is registered already is refused: this tool never replaces a row (`everyapp provider add --replace` from the terminal does); a preset registered already is answered as it is. For an OAuth provider the answer carries the redirect URI to register at the provider's console and where people connect. Owners and admins, on a self-hosted Gateway.",
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
            "An OAuth preset id from `everyapp_provider_list`'s `presets` (google-workspace, microsoft-365, slack, github-oauth, …). One of spec or preset.",
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
      "Remove a provider registered on this Gateway (an OAuth preset's row among them), by its id. Refused for a row whose key is set (remove it from the terminal: `everyapp provider remove <id>`, then `everyapp secret unset`), and for a row an app's deployed manifest lists under `capabilities` (naming the apps). The Gateway settings the row named stay until `everyapp secret unset`. Owners and admins, on a self-hosted Gateway.",
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
      "List the accounts connected to OAuth providers on this Gateway: the caller's own (any member), or with `all: true` every connection in the organization (owners and admins). A connection is one person's in one app. Each with the provider, the person, the app, the account's label at the provider, the scopes it holds, its status (active, or expired: the provider refused a refresh and the person connects again in the app) and when it was last used. Never a token. People connect inside each app; there is no tool for that.",
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
      "Remove a connection to an OAuth provider: the caller's own (any member), or for owners and admins another person's (`user`: their email or user id). Name it by `connection` (its id, from everyapp_provider_connections), or by `provider` with `app` when the person connected it in more than one app. The Gateway drops the tokens it held and revokes the grant at the provider where the spec knows how (`revoked` says whether it did); the app gets `integration_not_connected` until the person connects again in it.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The OAuth provider's id, as everyapp_provider_list lists it (with user and app, instead of connection).",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
        app: {
          type: "string",
          description:
            "The app the connection belongs to, by its id (needed only when the person connected the provider in more than one app).",
          minLength: 1,
          maxLength: 128,
        },
        connection: {
          type: "string",
          description:
            "The connection's id, as everyapp_provider_connections lists it (instead of provider, user and app).",
          minLength: 1,
          maxLength: 128,
        },
        user: {
          type: "string",
          description:
            "Whose connection, by email or user id (owners and admins; default: the caller's own).",
          minLength: 1,
          maxLength: 320,
        },
      },
      additionalProperties: false,
    },
  },
];
