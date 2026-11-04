/**
 * What the MCP app server functions (serverFunctions/mcpApps.ts) answer,
 * shared by the service that builds it and the dialogs that read it. An
 * "MCP app" is a provider-tier row of either kind: a built-in provider app
 * (DataForSEO) or a remote MCP server registered by URL
 * (docs/design/2026-10-mcp-by-url.md).
 */
import type {
  RemoteMcpAuthKind,
  RemoteMcpBlock,
  RemoteMcpCredentialKind,
  RemoteToolRiskSource,
  ToolRisk,
} from "@every-app/sdk/internal";

type McpAppKind = "builtin" | "remote";

/**
 * What the server's annotations said about a tool's risk, alone:
 * `destructive` is a write tool the server marks `destructiveHint`.
 */
export type RemoteToolRiskHint = ToolRisk | "destructive" | "unknown";

/**
 * Where a remote app's credential stands (docs/design/2026-11-mcp-apps-auth.md):
 * - `none`: the server takes no credential;
 * - `not_set`: an API-key provider whose key isn't set on the Gateway;
 * - `bound_elsewhere`: its key is set, but for other hosts or another auth
 *   than the provider has now (a replaced row): the operator sets it again;
 * - `ready`: an API-key provider whose key is set and bound;
 * - `no_client`: an OAuth provider the Gateway holds no client for;
 * - `not_connected`: an OAuth provider with a client, and nobody has
 *   connected it in the app yet;
 * - `connected`: an OAuth provider with at least one usable connection;
 * - `missing`: the provider the app names isn't on this Gateway (removed),
 *   or can't be an MCP server's credential.
 */
type McpAppCredentialState =
  | "none"
  | "not_set"
  | "bound_elsewhere"
  | "ready"
  | "no_client"
  | "not_connected"
  | "connected"
  | "missing";

/** The viewing member's own connection to an OAuth provider: never a token. */
interface McpAppViewerConnection {
  status: "active" | "expired";
  /** Who the provider says it is (an email, a login), when it says. */
  label: string | null;
}

export interface McpAppCredential {
  /** `api_key`: one key the Gateway holds; `oauth`: connections people make. */
  kind: "none" | "api_key" | "oauth";
  /** The provider id (`treg-mcp`, `elevenlabs`), or null for none. */
  provider: string | null;
  /** The provider's name as the registry has it. */
  providerName: string | null;
  /** Whether the provider is the app's own row (`<appId>-mcp`), written at add. */
  own: boolean;
  /** An API-key provider's setting (`TREG_MCP_TOKEN`); null otherwise. */
  name: string | null;
  /** Whether that setting is set on the Gateway (its env). */
  set: boolean;
  state: McpAppCredentialState;
  /** An OAuth app's active connections: the members who connected it in the app. */
  connections: number;
  /**
   * Where a member connects their account:
   * `/connect/<provider>?app=<appId>&return=/?mcp=<appId>`, a path on the
   * Gateway. Null for a key or none.
   */
  connectPath: string | null;
  /** The viewing member's own connection, for an OAuth app; null when none or not OAuth. */
  viewer: McpAppViewerConnection | null;
}

/** One tool a remote server listed, with how the Gateway serves it. */
export interface McpAppTool {
  /** The server's own name, which an override is keyed by. */
  upstreamName: string;
  /** The ToolBus name (`get_user`), or null when it has none. */
  localName: string | null;
  /** What AI clients call it on this Gateway's /mcp (`treg_get_user`). */
  listedName: string | null;
  title: string | null;
  riskHint: RemoteToolRiskHint;
  /** The effective risk: the snapshot's while it is current, else the rule's. */
  risk: ToolRisk;
  source: RemoteToolRiskSource;
  /** The operator left it on (no `enabled: false` override). */
  enabled: boolean;
  /** In the catalog at the last listing. */
  listed: boolean;
  /** Why it isn't listed, in plain words. */
  problem: string | null;
}

export interface McpAppSnapshot {
  /** The catalog's status, or null when the tools were never listed. */
  status: "ok" | "empty" | "unsupported" | "error" | null;
  fetchedAt: Date | null;
  lastError: string | null;
  toolCount: number;
}

/** `getMcpApp`'s answer. */
export interface McpAppDetails {
  /** The row's id. */
  id: string;
  /** The app id: its tool prefix (`treg_<tool>`). */
  appId: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  kind: McpAppKind;
  /** A remote app's stored block, or null for a built-in. */
  remote: RemoteMcpBlock | null;
  /** The origin the Gateway fetches (`https://treg.to`). */
  origin: string | null;
  authKind: RemoteMcpAuthKind | null;
  /** The auth kind in plain words ("bearer token"). */
  authLabel: string | null;
  credential: McpAppCredential | null;
  /** The command that sets the credential, while it needs setting. */
  setupCommand: string | null;
  snapshot: McpAppSnapshot;
  tools: McpAppTool[];
}

/** `addRemoteMcpApp`'s answer: what the result view says next. */
export interface AddedRemoteMcpApp {
  rowId: string;
  appId: string;
  name: string;
  /** `revived`: the id's own removed row came back. */
  kind: "new" | "revived";
  /** The stored block's kind: `none`, or `provider`. */
  authKind: RemoteMcpAuthKind;
  /** What the registrar chose: a credential kind, or `provider` (an existing one). */
  credentialKind: RemoteMcpCredentialKind | "provider";
  /** The provider the app's credential is (`treg-mcp`, `elevenlabs`), or null. */
  provider: string | null;
  /** An API-key provider's setting name (`TREG_MCP_TOKEN`). */
  secret: string | null;
  /** `pnpm everyapp secret set <NAME>`, while the key isn't set and bound. */
  setupCommand: string | null;
  /**
   * For an OAuth provider: where the adder connects their account
   * (`/connect/<provider>?app=<appId>&return=/?mcp=<appId>`), a path on the
   * Gateway.
   */
  connectPath: string | null;
  /** For a server added with OAuth: its authorization server, and how the client came. */
  oauth: { issuer: string; registered: "dcr" | "cimd" | "pasted" } | null;
  /**
   * The tools listed within the request, for a server with no credential;
   * null when no listing finished (the Gateway lists them on first use).
   */
  toolCount: number | null;
  /** The listing's status, when one finished. */
  toolsStatus: McpAppSnapshot["status"];
}

/** `refreshMcpAppTools`'s answer. */
export interface RefreshedMcpAppTools {
  status: McpAppSnapshot["status"];
  toolCount: number;
  /** Listed names that are new, and ones gone, against the last listing. */
  added: string[];
  removed: string[];
  error: string | null;
}

/**
 * `getMcpAppConnection`'s answer, for any member with the app: whether an
 * OAuth MCP app is connected for them (the launcher's MCP app dialog).
 * Null for an app that isn't an OAuth app.
 */
export interface McpAppConnectionStatus {
  /** The provider's name ("Treg MCP server"). */
  providerName: string;
  /** `/connect/<provider>?app=<appId>&return=/?mcp=<appId>`, a path on the Gateway. */
  connectPath: string;
  /** The member's own connection, made in the app; null when there is none yet. */
  connection: McpAppViewerConnection | null;
}
