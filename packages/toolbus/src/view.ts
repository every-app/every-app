import { type BuiltinHostOptions, type ListingMode } from "./builtins";
import { evaluateToolPolicy } from "./policy";
import { listTools } from "./server";
import type {
  McpPrincipal,
  OfferedApp,
  ToolBusApp,
  ToolBusView,
  UnavailableApp,
} from "./types";

/** Each app's own instructions are cut to this on the gateway surface. */
const MAX_APP_INSTRUCTIONS = 1024;
/** And all of them together to this, so many apps can't flood the context. */
const MAX_GATEWAY_INSTRUCTIONS = 8 * 1024;
/**
 * How much of a server's instructions Claude Code shows the model: the first
 * 4,096 characters (its MCP docs, "Scale with MCP tool search"; 2,048 before
 * 2.1.296; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes it). Codex reads
 * the first 512. The head of the gateway's instructions (the header, the app
 * list and the "not available" lines) should stay inside this, so the app
 * list is always what Claude sees. Nothing here clips the head; view.test.ts
 * checks it on the launch apps, and if that ever fails the fix is to shorten
 * those lines, not the apps' guidance.
 */
export const CLAUDE_CODE_INSTRUCTIONS_READ = 4096;
/**
 * Past either of these, a full listing (the built-ins it shows, the
 * workspace tools where the host runs them, and every app tool the policy
 * allows, as tools/list would serialize them) is served compactly unless
 * the caller chose otherwise. The count is claude.ai's reported connector
 * cap, where tools past it are dropped without a word; the bytes keep a
 * list of large schemas readable by the clients that load every
 * definition.
 */
export const FULL_LISTING_MAX_TOOLS = 256;
export const FULL_LISTING_MAX_BYTES = 1024 * 1024;

/**
 * The view for `<app-host>/mcp`: one app, its local tool names, its own
 * instructions.
 */
export function appSurfaceView(
  app: ToolBusApp,
  principal: McpPrincipal,
  requestId?: string,
): ToolBusView {
  return {
    surface: "app",
    principal,
    apps: [app],
    serverInfo: { name: `every-app-${app.appId}`, title: app.name },
    ...(app.instructions ? { instructions: app.instructions } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const byAppId = <T extends { appId: string }>(a: T, b: T) =>
  a.appId < b.appId ? -1 : 1;

/**
 * Whether the caller may act on operator state: an owner or admin of the
 * organization. Better Auth stores several roles comma-separated.
 */
export function isOwnerOrAdmin(orgRole: string): boolean {
  return orgRole
    .split(",")
    .some((role) => role.trim() === "owner" || role.trim() === "admin");
}

/** How many app tools the caller could reach: the policy-allowed ones. */
function reachableToolCount(
  principal: McpPrincipal,
  apps: ToolBusApp[],
): number {
  let count = 0;
  for (const app of apps) {
    for (const tool of app.tools) {
      if (evaluateToolPolicy(tool, principal).action === "allow") count += 1;
    }
  }
  return count;
}

/**
 * The listing mode a caller gets when it chose none: full while the full
 * listing fits, else compact. Counts what tools/list would list, so the
 * host says whether it runs the workspace tools (the gateway does; the
 * dev ToolBus doesn't).
 */
function defaultListing(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  host: BuiltinHostOptions,
): ListingMode {
  const full = listTools(
    {
      surface: "gateway",
      principal,
      apps,
      serverInfo: { name: "every-app" },
      listing: "full",
    },
    host,
  );
  if (full.length > FULL_LISTING_MAX_TOOLS) return "compact";
  const bytes = new TextEncoder().encode(JSON.stringify(full)).byteLength;
  return bytes > FULL_LISTING_MAX_BYTES ? "compact" : "full";
}

/**
 * The part of the gateway's instructions every client reads: the header
 * (which says how the tools are listed and found), the app list, one line
 * per app that needs setup and, for an owner or admin, one per provider
 * app an admin could turn on. It comes before any app's own guidance,
 * which a client may cut (`CLAUDE_CODE_INSTRUCTIONS_READ`).
 */
export function gatewayInstructionsHead(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  unavailable: UnavailableApp[],
  listing: ListingMode = "full",
  offered: OfferedApp[] = [],
): string {
  const sorted = [...apps].sort(byAppId);
  const organization = principal.organizationName ?? "your organization";
  // The head names only tools the caller's tools/list has: the write
  // wrapper is hidden from a read-only caller like any write tool, so its
  // head sends it to the read wrapper alone (builtins.test.ts checks this
  // for each mode and access).
  const run =
    principal.access === "write"
      ? "then everyapp_call_read or everyapp_call_write with a tool's name and arguments"
      : "then everyapp_call_read with a tool's name and arguments (this connection is read only)";
  const header =
    listing === "compact"
      ? `Tools for ${organization} on EveryApp. This connection lists its ${reachableToolCount(principal, apps)} tools compactly: call everyapp_search_tools (words, an app id, or both) to find tools and their input schemas, ${run}. Call everyapp_list_apps to see what each app is for.`
      : `Tools for ${organization} on EveryApp. Each tool is named \`<app>_<tool>\`; call everyapp_list_apps to see what each app is for. everyapp_search_tools finds a tool by words.`;
  return [
    header,
    sorted.length
      ? `Apps: ${sorted.map((app) => `${app.appId} (${app.name})`).join(", ")}.`
      : "No apps are available to this connection yet.",
    // An app that needs setup has no tools here; the client can still tell
    // its user what to do, since the reason carries the command.
    ...[...unavailable]
      .sort(byAppId)
      .map(
        (app) => `${app.appId} (${app.name}) is not available: ${app.reason}.`,
      ),
    // Operator state, for the people who can act on it: the view keeps
    // it from anyone else (gatewaySurfaceView).
    ...[...offered]
      .sort(byAppId)
      .map(
        (app) =>
          `${app.appId} (${app.name}) is off and its key is set: an admin runs ${app.command}.`,
      ),
  ].join("\n");
}

function gatewayInstructions(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  unavailable: UnavailableApp[],
  listing: ListingMode,
  offered: OfferedApp[],
): string {
  let text = gatewayInstructionsHead(
    principal,
    apps,
    unavailable,
    listing,
    offered,
  );
  // Each app's guidance follows, clipped; a later app's block is dropped
  // whole once the total reaches the cap. The cap never cuts the head: a
  // partial app list would mislead more than a long one.
  for (const app of [...apps].sort(byAppId)) {
    if (!app.instructions) continue;
    const block = `\n\n${app.appId}: ${clip(app.instructions, MAX_APP_INSTRUCTIONS)}`;
    if (text.length + block.length > MAX_GATEWAY_INSTRUCTIONS) break;
    text += block;
  }
  return text;
}

/**
 * The view for the gateway's own `/mcp`: every app the caller may reach,
 * under `<appId>_<tool>` names, with the built-in `everyapp_*` tools. The
 * apps the caller reaches but can't use yet (`unavailable`: they need
 * setup) serve no tools; the instructions and `everyapp_list_apps` say why.
 * The provider apps an admin could turn on (`offered`) are named the same
 * two ways, to an owner or admin only: whatever the host passes, a member's
 * view carries none. The listing mode is the caller's choice when it made
 * one, else full while the full listing fits (`FULL_LISTING_MAX_TOOLS`,
 * `FULL_LISTING_MAX_BYTES`) and compact past that; a host that runs the
 * workspace tools (`workspace: true`) has them counted, since its
 * tools/list lists them.
 */
export function gatewaySurfaceView(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  options: {
    requestId?: string;
    allowedOrigins?: readonly string[];
    unavailable?: UnavailableApp[];
    offered?: OfferedApp[];
    /** The caller's explicit listing choice (`X-EveryApp-Tools`, `?tools=`). */
    listing?: ListingMode;
    /** Whether the host runs the workspace tools (`ToolBusDeps.workspace`). */
    workspace?: boolean;
    /** Whether the host registers providers here (`WorkspaceHost.providers`). */
    providers?: boolean;
  } = {},
): ToolBusView {
  const unavailable = options.unavailable ?? [];
  const offered = isOwnerOrAdmin(principal.orgRole)
    ? (options.offered ?? [])
    : [];
  const listing =
    options.listing ??
    defaultListing(principal, apps, {
      workspace: options.workspace === true,
      providers: options.providers === true,
    });
  return {
    surface: "gateway",
    principal,
    apps,
    listing,
    ...(unavailable.length ? { unavailable } : {}),
    ...(offered.length ? { offered } : {}),
    serverInfo: {
      name: "every-app",
      title: principal.organizationName
        ? `${principal.organizationName} · EveryApp`
        : "EveryApp",
    },
    instructions: gatewayInstructions(
      principal,
      apps,
      unavailable,
      listing,
      offered,
    ),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.allowedOrigins?.length
      ? { allowedOrigins: options.allowedOrigins }
      : {}),
  };
}
