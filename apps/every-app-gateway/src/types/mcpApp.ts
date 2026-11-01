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
  RemoteToolRiskSource,
  ToolRisk,
} from "@every-app/sdk/internal";

type McpAppKind = "builtin" | "remote";

/** What the server's annotations said about a tool's risk, alone. */
export type RemoteToolRiskHint = ToolRisk | "unknown";

/**
 * Where a remote app's credential stands:
 * - `none`: the server takes no credential;
 * - `unsupported`: it wants OAuth, which the Gateway doesn't do yet;
 * - `not_set`: the Gateway setting isn't set;
 * - `set`: set and not bound yet (the Gateway binds it on first use);
 * - `bound`: set and bound to the app's own origin;
 * - `bound_elsewhere`: set for another origin; the operator sets it again.
 */
type McpAppCredentialState =
  | "none"
  | "unsupported"
  | "not_set"
  | "set"
  | "bound"
  | "bound_elsewhere";

export interface McpAppCredential {
  /** The Gateway setting's name (`TREG_MCP_TOKEN`), or null for none/oauth. */
  name: string | null;
  /** Whether the Gateway has it set (its env). */
  set: boolean;
  /** The origin it is bound to (`remote_mcp_credentials`), if any. */
  boundTo: string | null;
  state: McpAppCredentialState;
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
  authKind: RemoteMcpAuthKind;
  /** The credential's setting name, for a kind that takes one. */
  secret: string | null;
  /** `pnpm everyapp secret set <NAME>`, while it isn't set. */
  setupCommand: string | null;
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
