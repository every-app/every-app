/**
 * The provider tools: the API provider registry
 * (docs/design/2026-10-provider-registry.md, section 8) on the gateway's
 * own /mcp, under `everyapp_provider_*`, beside the workspace tools and
 * run the same way (kind `host`, `ToolBusDeps.workspace`).
 *
 * `everyapp_provider_list` reads the catalog and this gateway's rows for
 * every member: what an agent needs to write a manifest's `capabilities`
 * and to tell a person which key to set. `everyapp_provider_add` and
 * `everyapp_provider_remove` write the rows for owners and admins, and
 * only where the host registers providers (`WorkspaceHost.providers`: a
 * self-hosted gateway; a hosted one hides them, Unknown tool on call).
 * `add` takes the spec object alone, never a URL to fetch and never a
 * replace of a row that is there; `remove` takes the id alone and refuses
 * a row whose key is bound, a row an app lists and a built-in. No value
 * passes through either: a spec names its secrets, the key is set from the
 * terminal (`everyapp secret set`).
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
      "List the API providers this Gateway brokers: the built-in catalog and the ones registered on this Gateway, each with its id (what an app lists under `capabilities`), name, kind (api_key, ai, oauth_client), where the key goes, hosts, docs link, hint, and the Gateway settings it reads. For owners and admins, whether each setting is set. Never a value. Any member.",
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
      "Register an API provider on this Gateway from its spec: `{ id, name, docs, hosts, auth: { kind: bearer | header | query | basic, secret: SETTING_NAME, … }, hint?, secrets?, access?, writeMethods?, accountWidePaths?, data?, smoke?, cost?, rate? }`, as `everyapp provider add` takes it (the spec names its settings; it never carries a value). The id must not be a built-in provider's, its settings must start with its own id (`STRIPE_` for `stripe`) and be nobody else's, and its hosts must be the provider's own public https hosts. An id that is registered already is refused: this tool never replaces a row (`everyapp provider add --replace` from the terminal does). The answer says which setting to set next, from the terminal: `everyapp secret set NAME`. Owners and admins, on a self-hosted Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description:
            "The provider spec object (never a URL). Its fields are checked by the same parser as `everyapp provider add`; a problem names the field.",
        },
      },
      required: ["spec"],
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
];
