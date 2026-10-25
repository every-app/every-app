/**
 * The remote MCP client and normalizer: what the gateway uses to serve a
 * remote MCP server as an MCP app (docs/design/2026-10-mcp-by-url.md).
 */
export {
  CALL_MAX_BYTES,
  CALL_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MAX_LIST_PAGES,
  RemoteMcpClient,
  RemoteMcpError,
  type RemoteMcpClientOptions,
  type RemoteMcpErrorKind,
  type UpstreamCallResult,
  type UpstreamListing,
  type UpstreamTool,
} from "./client";
export {
  normalizeRemoteCatalog,
  riskHintOf,
  type NormalizedRemoteCatalog,
  type RemoteToolRecord,
  type RiskHint,
} from "./normalize";
