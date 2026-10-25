/**
 * Remote MCP apps as the gateway serves them (docs/design/2026-10-mcp-by-url.md):
 * a remote MCP server registered by URL (`everyapp mcp add`, Admin → Apps,
 * `everyapp_mcp_add`) as a provider-tier row whose manifest carries a
 * `remote` block, served to members' AI clients through the gateway's one
 * `/mcp` like a built-in provider app (server/provider-apps): the same
 * catalog snapshot, the same per-call identity, policy, audit row and
 * usage counters. What differs is the in-process app behind the seam: it
 * answers the internal tools contract itself (`/__everyapp/tools/list`,
 * `/__everyapp/tools/call`), listing the server's tools through the
 * ToolBus's remote client ({@link RemoteMcpClient}) and forwarding each
 * call with the credential the gateway holds ({@link credentialFor}).
 *
 * Identity: the gateway mints each call's identity for `aud`
 * `provider:<row id>` as for a built-in, and this app verifies it with the
 * gateway's own public key before anything goes upstream; the member's
 * own token never does (the spec forbids passthrough; the gateway never
 * had it). The scope a tool needs follows its effective risk (the
 * conservative mapping and the operator's overrides, `remoteToolRisk`).
 *
 * The catalog: the server's `tools/list`, normalized
 * (`normalizeRemoteCatalog`), hashed with `catalogHash()` so a changed
 * list changes the hash and the ToolBus re-syncs on drift; cached per
 * isolate for the upstream's `ttlMs` or {@link LISTING_CACHE_MS}; every
 * listing also written to `remote_mcp_tools` for `everyapp mcp show` and
 * the MCP app dialog.
 *
 * Nothing here puts the credential, the request headers or an upstream
 * body verbatim in a result, an audit row or a log line: a failure is one
 * sentence naming what happened, and the log carries the client's
 * sanitized head.
 */
import { env, waitUntil } from "cloudflare:workers";
import {
  AppUnreachableError,
  logEvent,
  type AppFetcher,
} from "@every-app/perimeter";
import {
  catalogHash,
  isProviderAppId,
  parseRemoteMcpBlock,
  remoteMcpUrlProblem,
  requiredScopeForRisk,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  TOOLS_PROTOCOL_VERSION,
  verifyIdentityJwt,
  verifySystemJwt,
  IdentityError,
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  PROVIDER_APP_TIER,
  type EveryAppUser,
  type RemoteMcpBlock,
  type ToolCallResultV1,
  type ToolDescriptorV1,
  type ToolsErrorCodeV1,
} from "@every-app/sdk/internal";
// The remote entry alone: the package's index carries the MCP server SDK,
// which stays out of the control plane's module graph (catalog-sync.ts
// loads it on demand), and this module is imported on every request.
import {
  normalizeRemoteCatalog,
  RemoteMcpClient,
  RemoteMcpError,
  type NormalizedRemoteCatalog,
} from "@every-app/toolbus/remote";
import { checkMonthlyCap } from "@/server/app-cap";
import {
  providerAudience,
  providerIdentityVerify,
} from "@/server/provider-apps";
import { OrgAppSettingsRepository } from "@/server/repositories/OrgAppSettingsRepository";
import { RemoteMcpRepository } from "@/server/repositories/RemoteMcpRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import type { UsageEvent } from "@/server/usage-event";
import { credentialFor, credentialProblem, type CredentialState } from "./bind";

/** How long a listing stays good in this isolate when the server sends no `ttlMs`. */
const LISTING_CACHE_MS = 10 * 60_000;
/** The longest `ttlMs` honoured: a server can't pin a stale list for a day. */
const LISTING_CACHE_MAX_MS = 60 * 60_000;
/** And the shortest: a server can't make every call re-list first. */
const LISTING_CACHE_MIN_MS = 30_000;
/** A forced re-list for a name the cache doesn't know happens at most this often. */
const FORCED_RELIST_MIN_MS = 30_000;
/** The usage counters' target for every remote app's calls. */
function remoteUsageTarget(appSlug: string): string {
  return `mcp:${appSlug}`;
}

/** The version a remote app's snapshot records: its registration's revision. */
export function remoteMcpVersion(block: Pick<RemoteMcpBlock, "rev">): string {
  return `remote:${block.rev}`;
}

/** The registry facts the fetcher needs. */
interface RemoteMcpRoute {
  rowId: string;
  organizationId: string;
  appSlug: string;
  /** The row's name, for descriptions and messages. */
  name?: string;
  manifest: string | null;
}

/**
 * The `remote` block of a provider-tier row, or null: a built-in
 * provider's row (its slug is in `PROVIDER_APPS`), a deployed app's, or
 * a row whose block can't be read.
 */
export function remoteMcpRouteOf(app: {
  tier: string;
  appSlug: string;
  manifest?: string | null;
}): RemoteMcpBlock | null {
  if (app.tier !== PROVIDER_APP_TIER || isProviderAppId(app.appSlug))
    return null;
  if (!app.manifest) return null;
  try {
    const manifest = JSON.parse(app.manifest) as { remote?: unknown };
    if (manifest.remote === undefined) return null;
    const parsed = parseRemoteMcpBlock(manifest.remote);
    return parsed.ok ? parsed.block : null;
  } catch {
    return null;
  }
}

let upstreamFetch: typeof fetch | undefined;

/** Tests stand in for the remote servers; `undefined` restores `fetch`. */
export function setRemoteUpstreamFetchForTests(
  fetcher: typeof fetch | undefined,
): void {
  upstreamFetch = fetcher;
}

interface Listing {
  catalog: NormalizedRemoteCatalog;
  hash: string;
  instructions: string | undefined;
  era: string;
  listedAt: number;
  ttlMs: number;
}

interface Entry {
  rev: number;
  url: string;
  credentialName: string | null;
  client: RemoteMcpClient;
  listing?: Listing;
  listing$?: Promise<Listing>;
  /** When a call last forced a re-list for a name the cache didn't know. */
  forcedAt?: number;
}

// Per isolate, by row: the client (its era and session) and the listing.
const entries = new Map<string, Entry>();
const ENTRIES_MAX = 200;

export function resetRemoteMcpForTests(): void {
  entries.clear();
}

function settings(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

function gatewayUrl(): string {
  const value = settings()["GATEWAY_URL"];
  return typeof value === "string" ? value.trim() : "";
}

/** What the URL rule reads of this gateway's environment. */
function urlEnv(): {
  gatewayUrl: string;
  appBaseDomain?: string | null;
  thirdPartyDomain?: string | null;
} {
  const read = (name: string) => {
    const value = settings()[name];
    return typeof value === "string" ? value : null;
  };
  return {
    gatewayUrl: gatewayUrl(),
    appBaseDomain: read("APP_BASE_DOMAIN"),
    thirdPartyDomain: read("THIRD_PARTY_DOMAIN"),
  };
}

function toolsJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function toolsError(
  status: number,
  code: ToolsErrorCodeV1,
  message: string,
): Response {
  return toolsJson(status, {
    v: TOOLS_PROTOCOL_VERSION,
    error: { code, message },
  });
}

function errorResult(hash: string, text: string): Response {
  const result: ToolCallResultV1 = {
    content: [{ type: "text", text }],
    isError: true,
  };
  return toolsJson(200, {
    v: TOOLS_PROTOCOL_VERSION,
    catalogHash: hash,
    result,
  });
}

/**
 * The entry for a row, built or rebuilt when the registration changed
 * (`rev`, the URL or the credential's name), with the client that holds
 * the era and session.
 */
async function entryFor(
  route: RemoteMcpRoute,
  block: RemoteMcpBlock,
  credential: CredentialState,
): Promise<Entry> {
  const credentialName = "name" in credential ? credential.name : null;
  const existing = entries.get(route.rowId);
  if (
    existing &&
    existing.rev === block.rev &&
    existing.url === block.url &&
    existing.credentialName === credentialName
  ) {
    return existing;
  }
  const headers = "headers" in credential ? credential.headers : {};
  const secrets = "secrets" in credential ? credential.secrets : [];
  const entry: Entry = {
    rev: block.rev,
    url: block.url,
    credentialName,
    client: new RemoteMcpClient({
      url: block.url,
      headers,
      secrets,
      clientInfo: { name: "every-app-gateway", version: "0.1" },
      ...(upstreamFetch ? { fetch: upstreamFetch } : {}),
    }),
  };
  entries.delete(route.rowId);
  entries.set(route.rowId, entry);
  if (entries.size > ENTRIES_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  return entry;
}

/** One sentence for the model about an upstream failure, never its body. */
function upstreamFailure(name: string, error: unknown): string {
  if (error instanceof RemoteMcpError) {
    switch (error.kind) {
      case "redirect":
        return `${name} redirected the request; this Gateway follows no redirects.`;
      case "unauthorized":
        return `${name} rejected the credential (401); its operator sets it again with everyapp secret set.`;
      case "forbidden":
        return `${name} refused the request (403).`;
      case "timeout":
        return `${name} did not answer in time.`;
      case "unreachable":
        return `${name} could not be reached.`;
      case "too_large":
        return `${name}'s answer is larger than this Gateway relays; ask for less.`;
      case "rpc":
        return `${name} answered an error${error.code !== undefined ? ` (${error.code})` : ""}.`;
      case "http":
        return `${name} answered ${error.status ?? "an error"}.`;
      case "protocol":
        return `${name} answered something this Gateway doesn't handle: ${error.message}.`;
    }
  }
  return `${name} failed to answer.`;
}

function logUpstreamFailure(
  route: RemoteMcpRoute,
  stage: "list" | "call",
  error: unknown,
  tool?: string,
): void {
  const detail =
    error instanceof RemoteMcpError
      ? {
          kind: error.kind,
          status: error.status,
          code: error.code,
          head: error.head,
        }
      : {
          kind: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
  logEvent(
    "mcp.remote.upstream_failed",
    {
      app: route.appSlug,
      appRowId: route.rowId,
      stage,
      ...(tool ? { tool } : {}),
      ...detail,
    },
    "warn",
  );
}

/**
 * List the server's tools, normalized and hashed; cached per isolate for
 * the upstream's `ttlMs` (capped) or {@link LISTING_CACHE_MS}; one
 * listing in flight per row. Writes `remote_mcp_tools` after the answer.
 */
async function listing(
  route: RemoteMcpRoute,
  block: RemoteMcpBlock,
  entry: Entry,
  force = false,
  signal?: AbortSignal,
): Promise<Listing> {
  const now = Date.now();
  if (
    !force &&
    entry.listing &&
    now - entry.listing.listedAt < entry.listing.ttlMs
  ) {
    return entry.listing;
  }
  if (entry.listing$) return entry.listing$;
  entry.listing$ = (async () => {
    const upstream = await entry.client.listTools(signal);
    const appName = route.name ?? route.appSlug;
    const catalog = normalizeRemoteCatalog(
      route.appSlug,
      appName,
      upstream.tools,
      block,
    );
    const instructions = upstream.instructions?.slice(0, 2048);
    const hash = await catalogHash({
      ...(instructions ? { instructions } : {}),
      tools: catalog.tools,
    });
    const ttlMs = Math.max(
      LISTING_CACHE_MIN_MS,
      Math.min(upstream.ttlMs ?? LISTING_CACHE_MS, LISTING_CACHE_MAX_MS),
    );
    const listed: Listing = {
      catalog,
      hash,
      instructions,
      era: upstream.era,
      listedAt: Date.now(),
      ttlMs,
    };
    entry.listing = listed;
    logEvent("mcp.remote.listed", {
      app: route.appSlug,
      appRowId: route.rowId,
      era: upstream.era,
      tools: catalog.tools.length,
      skipped: catalog.records.filter((record) => !record.listed).length,
      truncated: upstream.truncated,
    });
    waitUntil(
      RemoteMcpRepository.replaceTools(
        route.rowId,
        route.organizationId,
        catalog.records,
      ).catch((error: unknown) =>
        logEvent(
          "mcp.remote.tools_record_failed",
          {
            app: route.appSlug,
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        ),
      ),
    );
    return listed;
  })().finally(() => {
    entry.listing$ = undefined;
  });
  return entry.listing$;
}

/** Why the row can't be served at all, before anything is fetched. */
async function refusal(
  route: RemoteMcpRoute,
  block: RemoteMcpBlock,
): Promise<{ credential: CredentialState } | { problem: string }> {
  const urlProblem = remoteMcpUrlProblem(block.url, urlEnv());
  if (urlProblem) {
    logEvent(
      "mcp.remote.refused",
      { app: route.appSlug, appRowId: route.rowId, problem: urlProblem },
      "warn",
    );
    return {
      problem: `${route.name ?? route.appSlug}'s address is refused by this Gateway (${urlProblem}).`,
    };
  }
  const credential = await credentialFor(block, route.rowId);
  const credentialIssue = credentialProblem(credential);
  if (credentialIssue) {
    return {
      problem: `${route.name ?? route.appSlug} isn't ready: ${credentialIssue}.`,
    };
  }
  return { credential };
}

/** `POST /__everyapp/tools/list` for a remote row. */
async function listTools(
  request: Request,
  route: RemoteMcpRoute,
  block: RemoteMcpBlock,
): Promise<Response> {
  const verify = await providerIdentityVerify(route.rowId);
  try {
    await verifySystemJwt(request.headers.get(SYSTEM_HEADER) ?? "", {
      ...verify,
      purpose: "tools.list",
    });
  } catch (error) {
    if (error instanceof IdentityError)
      return toolsError(401, "unauthenticated", error.message);
    throw error;
  }
  const gate = await refusal(route, block);
  if ("problem" in gate) return toolsError(500, "misconfigured", gate.problem);
  const entry = await entryFor(route, block, gate.credential);
  let listed: Listing;
  try {
    listed = await listing(route, block, entry, true, request.signal);
  } catch (error) {
    logUpstreamFailure(route, "list", error);
    return toolsError(
      500,
      "misconfigured",
      upstreamFailure(route.name ?? route.appSlug, error),
    );
  }
  const tools: ToolDescriptorV1[] = listed.catalog.tools;
  return toolsJson(200, {
    v: TOOLS_PROTOCOL_VERSION,
    sdk: `remote:${listed.era}`,
    hash: listed.hash,
    ...(listed.instructions ? { instructions: listed.instructions } : {}),
    tools,
    ...(listed.catalog.warnings.length > 0
      ? { warnings: listed.catalog.warnings }
      : {}),
  });
}

function parseCallBody(
  body: unknown,
): { name: string; arguments: Record<string, unknown>; callId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record["v"] !== TOOLS_PROTOCOL_VERSION) return null;
  const { name, callId } = record;
  const args = record["arguments"] ?? {};
  if (
    typeof name !== "string" ||
    !name ||
    typeof callId !== "string" ||
    !callId
  )
    return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: args as Record<string, unknown>, callId };
}

/** `POST /__everyapp/tools/call` for a remote row. */
async function callTool(
  request: Request,
  route: RemoteMcpRoute,
  block: RemoteMcpBlock,
): Promise<Response> {
  const verify = await providerIdentityVerify(route.rowId);
  let user: EveryAppUser;
  try {
    user = await verifyIdentityJwt(
      request.headers.get(IDENTITY_HEADER) ?? "",
      verify,
    );
  } catch (error) {
    if (error instanceof IdentityError)
      return toolsError(401, "unauthenticated", error.message);
    throw error;
  }
  if (user.channel !== "mcp" || !user.toolCall) {
    return toolsError(
      403,
      "forbidden",
      "Tool calls need an identity the gateway minted for this call.",
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const call = parseCallBody(body);
  if (!call) {
    return toolsError(
      400,
      "invalid_request",
      `Expected {"v":${TOOLS_PROTOCOL_VERSION},"name","arguments","callId"}.`,
    );
  }
  if (call.name !== user.toolCall.name || call.callId !== user.toolCall.id) {
    return toolsError(
      403,
      "forbidden",
      "The identity was minted for a different tool call.",
    );
  }
  if (user.orgId !== route.organizationId) {
    return toolsError(
      403,
      "forbidden",
      "This app isn't available to this organization.",
    );
  }
  const appName = route.name ?? route.appSlug;
  // The organization's monthly cap on the row (Admin → Usage), checked
  // before anything goes upstream, as for a built-in provider app.
  const cap = await checkMonthlyCap(
    {
      monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
      monthlyCalls: UsageRepository.monthlyCalls,
    },
    route.organizationId,
    route.rowId,
  );
  if (cap.exceeded) {
    logEvent(
      "usage.cap_exceeded",
      {
        organizationId: route.organizationId,
        appId: route.appSlug,
        appRowId: route.rowId,
        cap: cap.cap,
        calls: cap.calls,
        month: cap.month,
      },
      "warn",
    );
    return errorResult(
      "",
      `${appName} has reached this organization's monthly cap of ${cap.cap} calls; an owner or admin raises it in Admin → Usage, or it resets with the next UTC month.`,
    );
  }
  const gate = await refusal(route, block);
  if ("problem" in gate) return toolsError(500, "misconfigured", gate.problem);
  const entry = await entryFor(route, block, gate.credential);
  let listed: Listing;
  try {
    listed = await listing(route, block, entry, false, request.signal);
    if (!listed.catalog.map.has(call.name)) {
      // A tool the snapshot knows and the cache doesn't: list once more,
      // at most every FORCED_RELIST_MIN_MS, so a stale name can't drive
      // credentialed listings on every call.
      const now = Date.now();
      if (!entry.forcedAt || now - entry.forcedAt >= FORCED_RELIST_MIN_MS) {
        entry.forcedAt = now;
        listed = await listing(route, block, entry, true, request.signal);
      }
    }
  } catch (error) {
    logUpstreamFailure(route, "list", error, call.name);
    return errorResult("", upstreamFailure(appName, error));
  }
  const upstreamName = listed.catalog.map.get(call.name);
  const descriptor = listed.catalog.tools.find(
    (tool) => tool.name === call.name,
  );
  if (!upstreamName || !descriptor) {
    return toolsError(404, "unknown_tool", `Unknown tool: ${call.name}`);
  }
  const scope = requiredScopeForRisk(descriptor.risk);
  if (!user.scopes.includes(scope)) {
    return toolsError(
      403,
      "forbidden",
      `Calling ${call.name} needs the ${scope} scope.`,
    );
  }
  const count = (status: number) => {
    const event: UsageEvent = {
      organizationId: route.organizationId,
      appRowId: route.rowId,
      userId: user.id,
      kind: "capability",
      target: remoteUsageTarget(route.appSlug),
      status,
      calls: 1,
    };
    waitUntil(
      UsageRepository.record(event).catch((error: unknown) =>
        logEvent(
          "usage.record.failed",
          {
            app: route.appSlug,
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        ),
      ),
    );
  };
  try {
    const result = await entry.client.callTool(
      upstreamName,
      call.arguments,
      request.signal,
    );
    count(result.isError ? 400 : 200);
    const relayed: ToolCallResultV1 = {
      content: result.content as ToolCallResultV1["content"],
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError ? { isError: true } : {}),
    };
    return toolsJson(200, {
      v: TOOLS_PROTOCOL_VERSION,
      catalogHash: listed.hash,
      result: relayed,
    });
  } catch (error) {
    logUpstreamFailure(route, "call", error, upstreamName);
    const status =
      error instanceof RemoteMcpError && error.status ? error.status : 502;
    count(status >= 400 ? status : 502);
    return errorResult(listed.hash, upstreamFailure(appName, error));
  }
}

/**
 * Reach a remote MCP app in-process: the contract's two paths, answered
 * from the server through the client. Built per request; the client and
 * the listing are kept per isolate and row.
 */
export function remoteMcpAppFetcher(route: RemoteMcpRoute): AppFetcher {
  const block = remoteMcpRouteOf({
    tier: PROVIDER_APP_TIER,
    appSlug: route.appSlug,
    manifest: route.manifest,
  });
  if (!block) {
    throw new AppUnreachableError(
      `"${route.appSlug}" is not a remote MCP app this gateway can serve.`,
    );
  }
  return {
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST")
        return toolsError(405, "method_not_allowed", "Use POST.");
      if (pathname === TOOLS_LIST_PATH) return listTools(request, route, block);
      if (pathname === TOOLS_CALL_PATH) return callTool(request, route, block);
      return new Response("Not found", { status: 404 });
    },
  };
}
