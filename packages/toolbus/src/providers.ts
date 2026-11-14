/**
 * The provider tools: the API provider registry
 * (docs/design/2026-10-provider-registry.md, section 8) and the OAuth
 * providers people connect their accounts to
 * (docs/design/2026-10-oauth-providers.md, section 9;
 * docs/design/2026-11-oauth-one-connection.md) on the gateway's own
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
 * admins, `all: true`), each one person's to one provider, with the apps
 * that person allowed to use it; `everyapp_provider_disconnect` removes
 * the caller's own, or any for owners and admins, revoking the grant at
 * the provider where the spec knows how, or with `app` takes that one
 * app's access away and leaves the connection. Neither carries a token.
 *
 * `everyapp_provider_composio` shows the caller's own Composio link
 * (docs/design/2026-11-composio.md): whether the organization turned
 * Composio on, the account it is linked as, and what is in it that
 * EveryApp supports. `everyapp_provider_composio_link` starts a sign-in
 * at Composio and answers its page for the person to approve;
 * `everyapp_provider_composio_link_finish` asks whether they did, and
 * links when so; `everyapp_provider_composio_unlink` drops the link and
 * the connections made through it. All four are every member's, for
 * their own link, and none carries the key. The organization's switch is
 * `everyapp_workspace_composio` (workspace.ts).
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
      "Register a provider on this Gateway: an API provider from its spec `{ id, name, docs, hosts, auth: { kind: bearer | header | query | basic, secret: SETTING_NAME, … }, hint?, secrets?, access?, writeMethods?, accountWidePaths?, data?, smoke?, cost?, rate? }`, an OAuth provider from a spec with `auth: { kind: oauth2-user, authorizeUrl, tokenUrl, clientId: SETTING_NAME, clientSecret?: SETTING_NAME, … }` (no scopes: each app lists its own), or an OAuth preset by id (`{ preset: \"google-workspace\" }`; `everyapp_provider_list` names them; deploying an app that lists a preset registers it too). A spec names its settings and never carries a value: a client id or secret is set from the terminal (`everyapp secret set NAME`) or pasted under Admin → Providers, never through a tool. The id must not be a built-in provider's, its settings must start with its own id (`STRIPE_` for `stripe`) and be nobody else's, and its hosts must be the provider's own public https hosts. A spec whose id is registered already is refused: this tool never replaces a row (`everyapp provider add --replace` from the terminal does); a preset registered already is answered as it is. For an OAuth provider the answer carries the redirect URI to register at the provider's console; each person then connects once, from inside an app that lists it. Owners and admins, on a self-hosted Gateway.",
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
      "List the accounts connected to OAuth providers on this Gateway: the caller's own (any member), or with `all: true` every connection in the organization (owners and admins). A connection is one person's to one provider, used by the apps that person allowed. Each with the provider, the person, the apps allowed to use it (`apps`), the account's label at the provider, how it was made (`via`: `oauth`, with the Gateway's own OAuth app, or `composio`, through the person's Composio), the scopes it holds (a connection through Composio holds `services` instead, each with its account there), `permissions` (how many of the scopes its apps list were granted, and `notGranted`: fewer than all is the person's choice at the provider, the connection works, and it is not a problem to report), its status (active, or expired: the person connects again from inside an app that uses it) and when it was last used. Never a token. A person connects once, from inside an app that lists the provider, and allows each other app on the Gateway's own page; there is no tool for either.",
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
    title: "Disconnect an account, or one app from it",
    description:
      "Remove a connection to an OAuth provider, or with `app` take that one app's access to it away: the caller's own (any member), or for owners and admins another person's (`user`: their email or user id). Name the connection by `connection` (its id, from everyapp_provider_connections) or by `provider`. Without `app`, the Gateway drops the tokens it held and revokes the grant at the provider where the spec knows how (`revoked` says whether it did; a connection made through Composio holds no token, so nothing is revoked and nothing changes at Composio); every app the person allowed gets `integration_not_connected` until they connect again. With `app`, the connection stays for the other apps and nothing is revoked; that app gets `integration_not_connected` until the person allows it again.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The OAuth provider's id, as everyapp_provider_list lists it (with user, instead of connection).",
          minLength: 2,
          maxLength: PROVIDER_ID_MAX,
        },
        app: {
          type: "string",
          description:
            "An app allowed to use the connection, by its id (everyapp_provider_connections lists them under `apps`): take this app's access away and leave the connection. Leave it out to remove the connection.",
          minLength: 1,
          maxLength: 128,
        },
        connection: {
          type: "string",
          description:
            "The connection's id, as everyapp_provider_connections lists it (instead of provider and user).",
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
  {
    risk: "read",
    minRole: "member",
    name: "provider_composio",
    title: "Show the caller's Composio link",
    description:
      "Show the caller's own Composio link on this Gateway. Composio is a third-party service where a person connects their accounts; where an organization turned it on, an OAuth provider with no OAuth app on this Gateway is used through the accounts in each person's own Composio. Answers whether the organization turned it on (`composio`: on or off), whether the caller linked (`linked`), the Composio account it is linked as (`account`), and `providers`: what is in their Composio that EveryApp supports, each provider with its services (`services`: Gmail and Calendar are separate accounts in Composio, each with the accounts' names) and whether the caller's connection to it is one made through Composio (`connected`). The accounts are read from Composio on every call, and nothing of them is stored; `providers` is null when Composio didn't answer. Linking adds no connection: an account becomes the caller's connection when an app asks for it and they say yes, on the Gateway's page in a browser. Never a key. Any member, their own link only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "member",
    name: "provider_composio_link",
    title: "Start linking the caller's Composio",
    description:
      "Start linking the caller's own Composio account to this Gateway. Answers `url`, a sign-in page at Composio that the person approves in their browser, and `expiresAt`, when that page stops working (about ten minutes). Give the link to the person this connection acts as and to nobody else (until it is used, whoever holds it can take over the sign-in), then call everyapp_provider_composio_link_finish every couple of seconds until it answers `linked` or `expired`. Starting again replaces a sign-in that is waiting. Refused with COMPOSIO_OFF until an owner or admin turns Composio on (everyapp_workspace_composio), and with COMPOSIO_ALREADY_LINKED when Composio is linked already: unlink first. Nobody types or pastes a key, and none passes through a tool. Any member, their own link only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "member",
    name: "provider_composio_link_finish",
    title: "Finish linking the caller's Composio",
    description:
      "See whether the person approved the sign-in everyapp_provider_composio_link started, and link their Composio when they did. Answers `state`: `waiting` (not approved yet: call again in a couple of seconds), `linked` (with the link as everyapp_provider_composio shows it) or `expired` (the sign-in ran out, or none was started: start again). Linking adds no connection. Never a key. Any member, their own link only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    risk: "write",
    minRole: "member",
    name: "provider_composio_unlink",
    title: "Unlink the caller's Composio",
    description:
      "Unlink the caller's own Composio from this Gateway: the Gateway drops the key it held, any sign-in that is waiting and every connection the caller made through Composio, with the access their apps had to them, so those apps stop at once (`integration_not_connected` until the person links again and connects again). A connection made with the Gateway's own OAuth app stays. Nothing changes at Composio: the accounts stay connected there and the key stays valid until the person revokes it there. `removed` says whether there was a link. Any member, their own link only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
