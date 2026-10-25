/**
 * MCP apps from Admin → Apps (docs/design/2026-10-mcp-by-url.md, section
 * 4, "The UI"): add a remote MCP server by URL, change it, turn an MCP app
 * of either kind on or off, remove one, list its tools again, and show it
 * with every tool's risk and where that risk comes from. The rules are the
 * registry's (@every-app/perimeter/registry remoteMcpApps.ts), the same the
 * CLI runs against D1; a refusal comes back as a PublicError with the
 * rule's code and sentence, which the form shows as it is.
 *
 * Owners and admins do all of it but remove, which is the owners' (as
 * deleting an app is). The server functions' middleware checks the role;
 * each operation checks it again here.
 *
 * `on`/`off` are the status for both kinds (`active` serves, `disabled`
 * keeps access, tokens and the snapshot and serves nothing); `remove` is
 * the tombstone, which #599's `off` used to be.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  isRemoteMcpRow,
  mcpAppRemoveUpdate,
  mcpAppStatusUpdate,
  planRemoteMcpAppAdd,
  remoteMcpAppUpdate,
  remoteMcpBlockOf,
  type AppRow,
  type RemoteMcpChange,
} from "@every-app/perimeter/registry";
import {
  PROVIDER_APP_TIER,
  remoteMcpAuthLabel,
  remoteMcpIdFromUrl,
  remoteMcpOf,
  remoteMcpSecretOf,
  remoteToolEnabled,
  remoteToolRisk,
  isToolRisk,
  type RemoteMcpBlock,
  type RemoteMcpUrlEnv,
  type ToolRisk,
} from "@every-app/sdk/internal";
import { SETUP_CLI } from "@/server/app-setup";
import { GatewayError, PublicError, getPublicErrorCode } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import {
  McpAppRepository,
  registryRow,
} from "@/server/repositories/McpAppRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import {
  logToolSync,
  syncAppTools,
  type SyncableApp,
} from "@/server/toolbus/catalog-sync";
import type {
  AddRemoteMcpAppInput,
  UpdateRemoteMcpAppInput,
} from "@/schemas/mcpApp";
import type {
  AddedRemoteMcpApp,
  McpAppCredential,
  McpAppDetails,
  McpAppSnapshot,
  McpAppTool,
  RefreshedMcpAppTools,
  RemoteToolRiskHint,
} from "@/types/mcpApp";

/**
 * How long adding a server with no credential waits for its tools to be
 * listed, so the answer can say how many; a listing still running then
 * finishes after the response, and the result view says the Gateway lists
 * them on first use. Under the proxy's own 15 s for a listing.
 */
const ADD_LISTING_BUDGET_MS = 8_000;
/** How long Refresh tools waits for the listing it asked for. */
const REFRESH_LISTING_BUDGET_MS = 20_000;

function settings(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

function setting(name: string): string | null {
  const value = settings()[name];
  return typeof value === "string" && value.trim() ? value : null;
}

/** What a remote server's URL is checked against: this Gateway's own addresses. */
function urlEnv(): RemoteMcpUrlEnv {
  return {
    gatewayUrl: setting("GATEWAY_URL") ?? "",
    appBaseDomain: setting("APP_BASE_DOMAIN"),
    thirdPartyDomain: setting("THIRD_PARTY_DOMAIN"),
  };
}

/** Whether the Gateway has a setting set, read as app-setup reads it. */
function isSet(name: string): boolean {
  return setting(name) !== null;
}

function secretSetCommand(name: string): string {
  return `${SETUP_CLI} secret set ${name}`;
}

function assertAdmin(ctx: OrgContext): void {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw new GatewayError(
      "UNAUTHORIZED",
      "Unauthorized: Organization admin access required",
    );
  }
}

function assertOwner(ctx: OrgContext): void {
  if (ctx.role !== "owner") {
    throw new GatewayError(
      "UNAUTHORIZED",
      "Unauthorized: Organization owner access required",
    );
  }
}

/**
 * A registry rule's refusal as the public error a form shows: its code
 * and its sentence. Anything else is thrown as it was.
 */
function asPublicError(error: unknown): unknown {
  const code = getPublicErrorCode(error);
  if (code && error instanceof Error && error.name === "RegistrationError") {
    return new PublicError(code, error.message);
  }
  return error;
}

function notFound(): PublicError {
  return new PublicError("APP_NOT_FOUND", "No MCP app with that id.");
}

/** The organization's live MCP app row (either kind), or APP_NOT_FOUND. */
async function findMcpRow(ctx: OrgContext, id: string) {
  const row = await AppRepository.findById(id, ctx.orgId);
  if (!row || row.tier !== PROVIDER_APP_TIER) throw notFound();
  return row;
}

/** The organization's live remote MCP app row, or APP_NOT_FOUND. */
async function findRemoteRow(ctx: OrgContext, id: string) {
  const row = await findMcpRow(ctx, id);
  if (!isRemoteMcpRow(row)) {
    throw new PublicError(
      "APP_NOT_FOUND",
      `"${row.appSlug}" is the Gateway's built-in MCP app, not a remote server.`,
    );
  }
  return row;
}

/**
 * The row as a sync reaches it. The manifest is what tells a remote
 * server's row from a built-in's (catalog-sync's appFetcherFor): without
 * it a remote row would be listed as a built-in provider, and fail.
 */
function syncable(
  app: Pick<AppRow, "id" | "organizationId" | "appSlug" | "name" | "manifest">,
): SyncableApp {
  return {
    rowId: app.id,
    organizationId: app.organizationId,
    appSlug: app.appSlug,
    hostname: null,
    workerName: null,
    tier: PROVIDER_APP_TIER,
    versionId: null,
    manifest: app.manifest,
    name: app.name,
  };
}

type Listing = {
  status: McpAppSnapshot["status"];
  toolCount: number;
  error: string | null;
};

/**
 * List an MCP app's tools now (catalog-sync's syncAppTools, the seam the
 * /mcp path takes on first use), waiting up to `budgetMs`: the listing's
 * outcome, or null when it didn't finish in time (it finishes after the
 * response) or couldn't start (the app can't be reached from here yet).
 * Never throws.
 */
async function listToolsWithin(
  app: SyncableApp,
  budgetMs: number,
): Promise<Listing | null> {
  const listing: Promise<Listing | null> = syncAppTools(app).then(
    (result) => {
      logToolSync(app, result, "first_use");
      return {
        status: result.status,
        toolCount: result.toolCount,
        error: result.error ?? null,
      };
    },
    (error: unknown) => {
      logEvent(
        "mcp.catalog.sync_failed",
        {
          app: app.appSlug,
          trigger: "first_use",
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
      return null;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), budgetMs);
  });
  const outcome = await Promise.race([listing, late]);
  clearTimeout(timer);
  if (outcome === "late") {
    waitUntil(listing);
    return null;
  }
  return outcome;
}

/** What another organization's use of a credential name reads as: never an origin. */
const OTHER_ORGANIZATION = "another organization";

/**
 * Where each credential name of a live remote MCP app on this Gateway is
 * sent, for the rules' `secretUsedAt`: the origin, when the organization's
 * own app uses it; "another organization" when another organization's
 * does (one set of Gateway secrets serves every organization, so a name
 * one organization's server uses is never another's to point at the same
 * server, and its origin isn't told to them).
 */
async function credentialUse(
  organizationId: string,
): Promise<(secretName: string) => string | null> {
  const own = new Map<string, string>();
  const others = new Set<string>();
  for (const row of await McpAppRepository.findLiveProviderManifests()) {
    let block: RemoteMcpBlock | null = null;
    try {
      block = row.manifest ? remoteMcpOf(JSON.parse(row.manifest)) : null;
    } catch {
      block = null;
    }
    const secret = block ? remoteMcpSecretOf(block.auth) : null;
    if (!block || !secret) continue;
    if (row.organizationId !== organizationId) {
      others.add(secret);
      continue;
    }
    if (own.has(secret)) continue;
    try {
      own.set(secret, new URL(block.url).origin);
    } catch {
      // A stored URL that doesn't parse sends nothing anywhere.
    }
  }
  return (secretName) =>
    others.has(secretName) ? OTHER_ORGANIZATION : (own.get(secretName) ?? null);
}

/** The auth block as the rules read it: only the fields its kind takes. */
function authInput(
  auth: AddRemoteMcpAppInput["auth"],
): Record<string, unknown> {
  if (auth.kind === "none" || auth.kind === "oauth") return { kind: auth.kind };
  return {
    kind: auth.kind,
    ...(auth.secret ? { secret: auth.secret } : {}),
    ...(auth.kind === "header" && auth.header !== undefined
      ? { header: auth.header }
      : {}),
    ...(auth.kind === "header" && auth.prefix ? { prefix: auth.prefix } : {}),
  };
}

/**
 * Register a remote MCP server for the organization: the row and the
 * grants the rules plan (the person adding it, the owners and the admins),
 * then, for a server that takes no credential, its tools listed within the
 * request so the answer can say how many.
 */
async function add(
  ctx: OrgContext,
  input: AddRemoteMcpAppInput,
  actor: string | null,
): Promise<AddedRemoteMcpApp> {
  assertAdmin(ctx);
  const url = input.url.trim();
  // The id the rules will settle on, so its row (a tombstone included) is
  // read before they run: they read rows, they don't fetch them.
  const wanted = input.id ?? remoteMcpIdFromUrl(url);
  const [existing, members, secretUsedAt] = await Promise.all([
    wanted ? AppRepository.findByAppSlug(wanted, ctx.orgId) : undefined,
    OrganizationMembersRepository.listMembersForOrganization(ctx.orgId),
    credentialUse(ctx.orgId),
  ]);
  let plan;
  try {
    plan = planRemoteMcpAppAdd({
      organizationId: ctx.orgId,
      url,
      id: input.id ?? null,
      name: input.name ?? null,
      description: input.description ?? null,
      auth: authInput(input.auth),
      risk: input.risk ?? null,
      env: urlEnv(),
      existingApp: (id) =>
        existing && existing.appSlug === id ? registryRow(existing) : null,
      secretUsedAt,
      members: members.map((member) => ({ id: member.id, role: member.role })),
      actorUserId: ctx.userId,
      actor,
      now: Date.now(),
    });
  } catch (error) {
    throw asPublicError(error);
  }
  // events: mcp_app.added (kind "remote")
  await McpAppRepository.writeRemoteApp(plan.app, plan.grants);

  const secret = remoteMcpSecretOf(plan.remote.auth);
  let listing: Listing | null = null;
  if (plan.remote.auth.kind === "none") {
    listing = await listToolsWithin(syncable(plan.app), ADD_LISTING_BUDGET_MS);
  }
  return {
    rowId: plan.app.id,
    appId: plan.id,
    name: plan.app.name,
    kind: plan.kind,
    authKind: plan.remote.auth.kind,
    secret,
    setupCommand: secret && !isSet(secret) ? secretSetCommand(secret) : null,
    toolCount: listing ? listing.toolCount : null,
    toolsStatus: listing ? listing.status : null,
  };
}

/**
 * Change a remote MCP app in place (the risk default, the per-tool
 * overrides, the name or the description), its revision bumped so the
 * Gateway lists the tools again on first use. The URL and the auth never
 * change here: a server elsewhere is another app.
 */
async function update(
  ctx: OrgContext,
  input: UpdateRemoteMcpAppInput,
): Promise<{ remote: RemoteMcpBlock; name: string; description: string }> {
  assertAdmin(ctx);
  const row = await findRemoteRow(ctx, input.id);
  const change: RemoteMcpChange = {};
  if (input.risk !== undefined) change.risk = input.risk;
  if (input.tools !== undefined) change.tools = input.tools;
  if (input.tool !== undefined) change.tool = input.tool;
  if (input.name !== undefined) change.name = input.name;
  if (input.description !== undefined) change.description = input.description;
  let next;
  try {
    next = remoteMcpAppUpdate(registryRow(row), change);
  } catch (error) {
    throw asPublicError(error);
  }
  await McpAppRepository.updateRemoteApp(row.id, ctx.orgId, {
    manifest: next.manifest,
    name: next.name,
    description: next.description,
  });
  return {
    remote: next.remote,
    name: next.name,
    description: next.description,
  };
}

/**
 * Turn an MCP app of either kind on (`active`: served) or off
 * (`disabled`: access, tokens and the snapshot kept, nothing served).
 */
async function setStatus(
  ctx: OrgContext,
  input: { id: string; status: "active" | "disabled" },
): Promise<{ status: "active" | "disabled"; changed: boolean }> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  let change;
  try {
    change = mcpAppStatusUpdate(registryRow(row), input.status);
  } catch (error) {
    throw asPublicError(error);
  }
  if (change) {
    // events: mcp_app.enabled | mcp_app.disabled (by change.status)
    await McpAppRepository.setStatus(row.id, ctx.orgId, change.status);
  }
  return { status: input.status, changed: change !== null };
}

/**
 * Remove an MCP app of either kind: the tombstone, with everyone's
 * access, its tokens, its snapshot and its place in AI connections. The
 * credential stays set on the Gateway (only the operator unsets it).
 */
async function remove(ctx: OrgContext, input: { id: string }): Promise<void> {
  assertOwner(ctx);
  const row = await AppRepository.findById(input.id, ctx.orgId);
  if (!row || !mcpAppRemoveUpdate(registryRow(row))) throw notFound();
  // events: mcp_app.removed
  await AppRepository.tombstone(row);
}

/**
 * List an MCP app's tools again now: the snapshot dropped, the listing
 * taken within the request, and what changed against the last one.
 */
async function refreshTools(
  ctx: OrgContext,
  input: { id: string },
): Promise<RefreshedMcpAppTools> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  const listed = (names: string[]) =>
    names.map((name) => `${row.appSlug}_${name}`);
  const before = new Set(
    listed(await AppToolRepository.toolNames(row.id, ctx.orgId)),
  );
  await AppToolRepository.deleteSnapshot(row.id, ctx.orgId);
  const listing = await listToolsWithin(
    syncable(row),
    REFRESH_LISTING_BUDGET_MS,
  );
  const after = listed(await AppToolRepository.toolNames(row.id, ctx.orgId));
  const afterSet = new Set(after);
  return {
    status: listing?.status ?? null,
    toolCount: after.length,
    added: after.filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !afterSet.has(name)).sort(),
    error:
      listing === null
        ? "The Gateway couldn't list its tools just now; it tries again on first use."
        : listing.error,
  };
}

function riskHintOf(value: string): RemoteToolRiskHint {
  return isToolRisk(value) ? value : "unknown";
}

/** The hints a stored risk hint stands for, as remoteToolRisk reads them. */
function hintsOf(hint: RemoteToolRiskHint) {
  if (hint === "read") return { readOnlyHint: true };
  if (hint === "destructive") return { destructiveHint: true };
  return undefined;
}

/**
 * Whether the snapshot was taken from the block as it stands: its version
 * is the block's revision (`remote:<rev>`, the design's section 2), so the
 * risks it serves are the block's.
 */
function snapshotIsCurrent(
  versionId: string | null | undefined,
  block: RemoteMcpBlock,
): boolean {
  if (!versionId) return false;
  const prefix = `remote:${block.rev}`;
  return versionId === prefix || versionId.startsWith(`${prefix}:`);
}

async function credentialOf(block: RemoteMcpBlock): Promise<McpAppCredential> {
  if (block.auth.kind === "none") {
    return { name: null, set: false, boundTo: null, state: "none" };
  }
  if (block.auth.kind === "oauth") {
    return { name: null, set: false, boundTo: null, state: "unsupported" };
  }
  const name = block.auth.secret;
  const set = isSet(name);
  const boundTo = await McpAppRepository.findCredentialBinding(name);
  let origin: string | null = null;
  try {
    origin = new URL(block.url).origin;
  } catch {
    origin = null;
  }
  const state: McpAppCredential["state"] = !set
    ? "not_set"
    : boundTo === null
      ? "set"
      : boundTo === origin
        ? "bound"
        : "bound_elsewhere";
  return { name, set, boundTo, state };
}

/**
 * An MCP app as its dialog shows it: the row, the stored block, the
 * credential's state, the snapshot, and every tool the server listed with
 * its listed name, its risk and where that risk comes from (an override,
 * the app's default, the server's hint, or the fallback), on or off, and
 * why it isn't listed. An override for a tool the server no longer lists
 * is shown too, so it can be cleared.
 */
async function get(
  ctx: OrgContext,
  input: { id: string },
): Promise<McpAppDetails> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  const block = remoteMcpBlockOf(row);
  const catalog = await AppToolRepository.findCatalog(row.id, ctx.orgId);
  const snapshot: McpAppSnapshot = {
    status: catalog?.status ?? null,
    fetchedAt: catalog?.fetchedAt ?? null,
    lastError: catalog?.lastError ?? null,
    toolCount: catalog?.toolCount ?? 0,
  };
  const status = row.status === "active" ? "active" : "disabled";
  if (!block) {
    return {
      id: row.id,
      appId: row.appSlug,
      name: row.name,
      description: row.description,
      status,
      kind: isRemoteMcpRow(row) ? "remote" : "builtin",
      remote: null,
      origin: null,
      authKind: null,
      authLabel: null,
      credential: null,
      setupCommand: null,
      snapshot,
      tools: [],
    };
  }
  const [credential, rows] = await Promise.all([
    credentialOf(block),
    McpAppRepository.findListedTools(row.id, ctx.orgId),
  ]);
  const current = snapshotIsCurrent(catalog?.versionId, block);
  const tools: McpAppTool[] = rows.map((tool) => {
    const riskHint = riskHintOf(tool.riskHint);
    const decided = remoteToolRisk(hintsOf(riskHint), block, tool.upstreamName);
    const served =
      current && tool.listed && tool.servedRisk && isToolRisk(tool.servedRisk)
        ? (tool.servedRisk as ToolRisk)
        : null;
    return {
      upstreamName: tool.upstreamName,
      localName: tool.localName,
      listedName: tool.localName ? `${row.appSlug}_${tool.localName}` : null,
      title: tool.title ?? tool.servedTitle ?? null,
      riskHint,
      risk: served ?? decided.risk,
      source: decided.source,
      enabled: remoteToolEnabled(block, tool.upstreamName),
      listed: tool.listed,
      problem: tool.problem,
    };
  });
  const seen = new Set(rows.map((tool) => tool.upstreamName));
  for (const upstreamName of Object.keys(block.tools).sort()) {
    if (seen.has(upstreamName)) continue;
    const decided = remoteToolRisk(undefined, block, upstreamName);
    tools.push({
      upstreamName,
      localName: null,
      listedName: null,
      title: null,
      riskHint: "unknown",
      risk: decided.risk,
      source: decided.source,
      enabled: remoteToolEnabled(block, upstreamName),
      listed: false,
      problem:
        rows.length > 0 ? "The server doesn't list it now." : "Not listed yet.",
    });
  }
  let origin: string | null = null;
  try {
    origin = new URL(block.url).origin;
  } catch {
    origin = null;
  }
  return {
    id: row.id,
    appId: row.appSlug,
    name: row.name,
    description: row.description,
    status,
    kind: "remote",
    remote: block,
    origin,
    authKind: block.auth.kind,
    authLabel: remoteMcpAuthLabel(block.auth),
    credential,
    setupCommand:
      credential.name &&
      (credential.state === "not_set" || credential.state === "bound_elsewhere")
        ? secretSetCommand(credential.name)
        : null,
    snapshot,
    tools,
  };
}

export const McpAppService = {
  add,
  update,
  setStatus,
  remove,
  refreshTools,
  get,
} as const;
