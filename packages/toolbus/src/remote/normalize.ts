/**
 * A remote server's tool list as the ToolBus can serve it: names in the
 * ToolBus's shape, risks decided the gateway's way, the operator's
 * overrides applied, and a record per upstream tool saying what became of
 * it (docs/design/2026-10-mcp-by-url.md, "The catalog"). Pure: the gateway
 * writes the records to `remote_mcp_tools` and hands the descriptors to
 * the internal tools contract, where the ToolBus's own limits (schema
 * sizes, `x-mcp-header` stripping, unusable schemas) still apply.
 */
import {
  isHeaderSafeToolName,
  normalizeRemoteToolName,
  remoteToolEnabled,
  remoteToolRisk,
  type RemoteMcpBlock,
  type RemoteToolRiskSource,
  type ToolDescriptorV1,
  type ToolRisk,
} from "@every-app/sdk/internal";
import { isPlainObject } from "../io";
import { MAX_TOOL_NAME_LENGTH } from "../names";
import type { UpstreamTool } from "./client";

/** What the server's annotations say alone, before any default or override. */
export type RiskHint = ToolRisk | "unknown";

/** One upstream tool, and what the gateway made of it. */
export interface RemoteToolRecord {
  upstreamName: string;
  /** The ToolBus name, or null when it has none. */
  localName: string | null;
  title: string | null;
  riskHint: RiskHint;
  /** The risk it is served with, when listed. */
  risk: ToolRisk | null;
  source: RemoteToolRiskSource | null;
  listed: boolean;
  /** Why it isn't listed. */
  problem: string | null;
}

export interface NormalizedRemoteCatalog {
  /** The descriptors the contract answers, sorted by name. */
  tools: ToolDescriptorV1[];
  /** ToolBus name → the server's name, for a call. */
  map: Map<string, string>;
  records: RemoteToolRecord[];
  /** What was left out and why, for the snapshot's warnings. */
  warnings: string[];
}

const DESCRIPTION_MAX = 2048;
const TITLE_MAX = 100;
/** How many colliding names one problem text names. */
const COLLISION_NAMES_SHOWN = 3;
/** How many warnings a listing keeps (the snapshot keeps 100). */
const WARNINGS_MAX = 100;

/** What the server's annotations say about risk, by themselves. */
export function riskHintOf(
  annotations: Record<string, unknown> | undefined,
): RiskHint {
  if (!annotations) return "unknown";
  if (annotations["readOnlyHint"] === true) return "read";
  if (annotations["destructiveHint"] === true) return "destructive";
  if (
    annotations["readOnlyHint"] === false ||
    annotations["destructiveHint"] === false
  ) {
    return "write";
  }
  return "unknown";
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The longest local name that keeps `<appId>_<name>` within the client limit. */
function fitLocalName(appId: string, local: string): string {
  const room = MAX_TOOL_NAME_LENGTH - appId.length - 1;
  if (local.length <= room) return local;
  return (
    local.slice(0, Math.max(1, room)).replace(/_+$/g, "") || local.slice(0, 1)
  );
}

/**
 * Normalize a listing for the app `appId` under the operator's `block`.
 * Deterministic: the same listing and block give the same descriptors in
 * the same order, so the contract's hash only changes when something did.
 */
export function normalizeRemoteCatalog(
  appId: string,
  appName: string,
  upstream: readonly UpstreamTool[],
  block: Pick<RemoteMcpBlock, "risk" | "tools">,
): NormalizedRemoteCatalog {
  const warnings: string[] = [];
  const records: RemoteToolRecord[] = [];
  // Pass one: the names, so collisions are known before anything is listed.
  const seenUpstream = new Set<string>();
  const byLocal = new Map<string, UpstreamTool[]>();
  const named: Array<{ tool: UpstreamTool; local: string | null }> = [];
  for (const tool of upstream) {
    if (typeof tool.name !== "string" || !tool.name) continue;
    if (seenUpstream.has(tool.name)) {
      warnings.push(`${tool.name}: skipped, the server listed it twice`);
      continue;
    }
    seenUpstream.add(tool.name);
    const normalized = normalizeRemoteToolName(tool.name);
    const local = normalized ? fitLocalName(appId, normalized) : null;
    named.push({ tool, local });
    if (local) byLocal.set(local, [...(byLocal.get(local) ?? []), tool]);
  }

  const descriptors: ToolDescriptorV1[] = [];
  const map = new Map<string, string>();
  for (const { tool, local } of named) {
    const hint = riskHintOf(tool.annotations);
    const title =
      typeof tool.title === "string" && tool.title.trim()
        ? cut(tool.title.trim(), TITLE_MAX)
        : null;
    const record = (
      listed: boolean,
      problem: string | null,
      risk: ToolRisk | null,
      source: RemoteToolRiskSource | null,
      localName: string | null,
    ): void => {
      records.push({
        upstreamName: tool.name,
        localName,
        title,
        riskHint: hint,
        risk,
        source,
        listed,
        problem,
      });
      if (problem && warnings.length < WARNINGS_MAX) {
        warnings.push(`${cut(tool.name, 64)}: skipped, ${problem}`);
      }
    };
    if (!local) {
      record(
        false,
        "its name can't be made a tool name (letters, digits and underscores)",
        null,
        null,
        null,
      );
      continue;
    }
    if (!isHeaderSafeToolName(tool.name)) {
      record(
        false,
        "its name can't be sent to the server in a request header",
        null,
        null,
        local,
      );
      continue;
    }
    const collisions = byLocal.get(local) ?? [];
    if (collisions.length > 1) {
      const shown = collisions
        .slice(0, COLLISION_NAMES_SHOWN)
        .map((item) => cut(item.name, 64))
        .join(", ");
      const more = collisions.length - COLLISION_NAMES_SHOWN;
      record(
        false,
        `${collisions.length} tools normalize to "${local}" (${shown}${more > 0 ? ` and ${more} more` : ""})`,
        null,
        null,
        local,
      );
      continue;
    }
    const { risk, source } = remoteToolRisk(tool.annotations, block, tool.name);
    if (!remoteToolEnabled(block, tool.name)) {
      record(false, "turned off by the operator", risk, source, local);
      continue;
    }
    const descriptionSource =
      typeof tool.description === "string" && tool.description.trim()
        ? tool.description.trim()
        : (title ?? `The ${tool.name} tool of ${appName}.`);
    const inputSchema =
      isPlainObject(tool.inputSchema) && tool.inputSchema["type"] === "object"
        ? tool.inputSchema
        : { type: "object", properties: {}, additionalProperties: true };
    const annotations: ToolDescriptorV1["annotations"] = {};
    if (tool.annotations?.["idempotentHint"] === true)
      annotations.idempotentHint = true;
    if (tool.annotations?.["openWorldHint"] === true)
      annotations.openWorldHint = true;
    descriptors.push({
      name: local,
      ...(title ? { title } : {}),
      description: cut(descriptionSource, DESCRIPTION_MAX),
      risk,
      inputSchema,
      ...(isPlainObject(tool.outputSchema) &&
      tool.outputSchema["type"] === "object"
        ? { outputSchema: tool.outputSchema }
        : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    });
    map.set(local, tool.name);
    record(true, null, risk, source, local);
  }
  descriptors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  records.sort((a, b) =>
    a.upstreamName < b.upstreamName
      ? -1
      : a.upstreamName > b.upstreamName
        ? 1
        : 0,
  );
  return { tools: descriptors, map, records, warnings };
}
