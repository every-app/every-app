/**
 * The handlers behind the MCP app tools on the gateway's own /mcp
 * (`everyapp_mcp_*`, packages/toolbus/src/mcpApps.ts): Admin → Apps' MCP
 * apps for an admin's AI client, run through McpAppService exactly as the
 * server functions (serverFunctions/mcpApps.ts) run it, on the OrgContext
 * workspace-tools.ts builds from the caller's live role. Merged into its
 * handler map, so a refusal comes back the same way: a PublicError (a
 * registry rule's RegistrationError becomes one in the service) is the
 * tool error `CODE: message`, anything else a plain failure.
 *
 * An MCP app is named as a person would type it: its id (the tool prefix,
 * `treg`) or its row id. No answer carries a credential, and no input
 * takes one: a remote server's credential is a provider, said by its id,
 * an API key's setting NAME with whether it is set and bound (and the
 * command the operator runs to set it in a terminal), or an OAuth
 * provider's connection count and connect link. OAuth with a client the
 * server registers is allowed here; a pasted client is Admin → Apps' alone.
 */
import { env } from "cloudflare:workers";
import {
  DELETED_APP_STATUS,
  remoteMcpBlockOf,
} from "@every-app/perimeter/registry";
import {
  isProviderAppId,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppKeySetting,
  type ToolRisk,
} from "@every-app/sdk/internal";
import type { JsonObject, McpPrincipal } from "@every-app/toolbus";
import { SETUP_CLI } from "@/server/app-setup";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { McpAppService } from "@/server/services/McpAppService";
import { addRemoteMcpAppSchema } from "@/schemas/mcpApp";
import type { McpAppDetails } from "@/types/mcpApp";

type McpAppHandler = (
  ctx: OrgContext,
  args: JsonObject,
  principal: McpPrincipal,
) => Promise<JsonObject>;

/** How `mcp list`, `mcp show` and these tools say where an MCP app stands. */
type McpAppStatus = "on" | "off" | "needs setup";

function setting(name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value : null;
}

function requireText(args: JsonObject, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicError("INVALID_INPUT", `${field} is required`);
  }
  return value.trim();
}

function secretSetCommand(name: string): string {
  return `${SETUP_CLI} secret set ${name}`;
}

/**
 * The organization's live MCP app (either kind) by its id or row id. A
 * built-in that was never added has no row: the operator adds it.
 */
async function resolveMcpApp(ctx: OrgContext, ref: string) {
  const byId = await AppRepository.findById(ref, ctx.orgId);
  const bySlug = byId
    ? undefined
    : await AppRepository.findByAppSlug(ref, ctx.orgId);
  const row =
    byId ?? (bySlug && bySlug.status !== DELETED_APP_STATUS ? bySlug : null);
  if (row && row.tier === PROVIDER_APP_TIER) return row;
  if (!row && isProviderAppId(ref)) {
    throw new PublicError(
      "APP_NOT_FOUND",
      `${PROVIDER_APPS[ref].name} isn't added here; the operator adds it with ${SETUP_CLI} mcp on ${ref}`,
    );
  }
  throw new PublicError("APP_NOT_FOUND", `No MCP app "${ref}" here`);
}

/**
 * The credential as the tools say it: a built-in's key setting, or a
 * remote server's provider (an API key's setting and whether it is set
 * and bound; an OAuth provider's client, connections and connect link).
 * Null when the app takes none. Never a value.
 */
function credentialOf(details: McpAppDetails): JsonObject | null {
  if (details.kind === "builtin") {
    if (!isProviderAppId(details.appId)) return null;
    const name = providerAppKeySetting(details.appId);
    const set = setting(name) !== null;
    return { name, set, state: set ? "set" : "not_set" };
  }
  const credential = details.credential;
  if (!credential || credential.kind === "none") return null;
  if (credential.kind === "api_key") {
    return {
      kind: "api_key",
      provider: credential.provider,
      own: credential.own,
      name: credential.name,
      set: credential.set,
      bound: credential.state === "ready",
      state: credential.state,
    };
  }
  const gateway = setting("GATEWAY_URL")?.replace(/\/+$/, "") ?? "";
  return {
    kind: "oauth",
    provider: credential.provider,
    own: credential.own,
    connections: credential.connections,
    state: credential.state,
    ...(credential.connectPath
      ? { connect: `${gateway}${credential.connectPath}` }
      : {}),
  };
}

/** The command that opens the app, while its credential needs setting. */
function setupCommandOf(
  details: McpAppDetails,
  credential: JsonObject | null,
): string | null {
  if (details.kind === "remote") return details.setupCommand;
  return credential && credential["set"] === false
    ? secretSetCommand(String(credential["name"]))
    : null;
}

/**
 * On, off, or needs setup: on, but a key isn't set or is bound to other
 * hosts, an OAuth provider has no client or nobody has connected it yet,
 * its provider is
 * gone, or a remote app's stored block can't be read.
 */
function statusOf(details: McpAppDetails): McpAppStatus {
  if (details.status !== "active") return "off";
  if (details.kind === "remote") {
    if (!details.remote) return "needs setup";
    const state = details.credential?.state ?? "none";
    return state === "none" || state === "ready" || state === "connected"
      ? "on"
      : "needs setup";
  }
  const credential = credentialOf(details);
  return credential && credential["set"] === false ? "needs setup" : "on";
}

/** One MCP app as the list and the show say it: never a credential's value. */
function summaryOf(details: McpAppDetails): JsonObject {
  const credential = credentialOf(details);
  const setupCommand = setupCommandOf(details, credential);
  const { snapshot } = details;
  return {
    id: details.appId,
    rowId: details.id,
    name: details.name,
    kind: details.kind,
    status: statusOf(details),
    // The snapshot's count; null when never listed, or the last listing failed.
    tools:
      snapshot.status === null || snapshot.status === "error"
        ? null
        : snapshot.toolCount,
    ...(details.remote
      ? {
          url: details.remote.url,
          auth: details.remote.auth.kind,
          ...(details.remote.auth.kind === "provider"
            ? { provider: details.remote.auth.provider }
            : {}),
          risk: details.remote.risk,
        }
      : {}),
    credential,
    ...(snapshot.fetchedAt ? { listedAt: snapshot.fetchedAt } : {}),
    ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
    ...(setupCommand ? { setupCommand } : {}),
  };
}

async function detailsOf(ctx: OrgContext, args: JsonObject) {
  const row = await resolveMcpApp(ctx, requireText(args, "app"));
  return McpAppService.get(ctx, { id: row.id });
}

/** A built-in's tools, as its snapshot serves them: the Gateway's own risks. */
async function builtinTools(ctx: OrgContext, appId: string) {
  const catalog = await AppToolRepository.findByOrgApp(ctx.orgId, appId);
  return (catalog?.tools ?? []).map((tool) => ({
    name: `${appId}_${tool.name}`,
    title: tool.title ?? null,
    risk: tool.risk,
    on: true,
  }));
}

/**
 * The override's risk from the tool's `risk`: `annotations` clears it (an
 * explicit undefined, which the rule's merge drops), nothing leaves it.
 */
function overrideRisk(value: unknown): { risk?: ToolRisk } {
  if (value === undefined) return {};
  if (value === "annotations") return { risk: undefined };
  if (value === "read" || value === "write") return { risk: value };
  throw new PublicError("INVALID_INPUT", "risk is read, write or annotations");
}

export const MCP_APP_HANDLERS: Record<string, McpAppHandler> = {
  async mcp_list(ctx) {
    const rows = (await AppRepository.findAll(ctx.orgId))
      .filter((row) => row.tier === PROVIDER_APP_TIER)
      .sort((a, b) => a.appSlug.localeCompare(b.appSlug));
    const apps = await Promise.all(
      rows.map(async (row) =>
        summaryOf(await McpAppService.get(ctx, { id: row.id })),
      ),
    );
    const gateway = setting("GATEWAY_URL");
    return {
      apps,
      ...(gateway ? { mcp: `${gateway.replace(/\/+$/, "")}/mcp` } : {}),
    };
  },

  async mcp_show(ctx, args) {
    const details = await detailsOf(ctx, args);
    const tools =
      details.kind === "builtin"
        ? await builtinTools(ctx, details.appId)
        : details.tools.map((tool) => ({
            name: tool.listedName,
            serverName: tool.upstreamName,
            title: tool.title,
            risk: tool.risk,
            source: tool.source,
            on: tool.enabled,
            listed: tool.listed,
            ...(tool.problem ? { problem: tool.problem } : {}),
          }));
    return {
      app: {
        ...summaryOf(details),
        description: details.description,
        ...(details.authLabel ? { authLabel: details.authLabel } : {}),
      },
      tools,
    };
  },

  async mcp_add(ctx, args, principal) {
    // A pasted OAuth client is a secret: Admin → Apps' sealed paste takes
    // it, never a tool (the model would have seen it).
    if (args["auth"] && typeof args["auth"] === "object") {
      const auth = args["auth"] as JsonObject;
      if (
        auth["clientId"] !== undefined ||
        auth["clientSecret"] !== undefined
      ) {
        throw new PublicError(
          "INVALID_INPUT",
          "A client id and secret are pasted in Admin → Apps or given to the CLI, never through a tool.",
        );
      }
    }
    const parsed = addRemoteMcpAppSchema.safeParse(args);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      throw new PublicError(
        "INVALID_INPUT",
        issue
          ? `${issue.path.join(".") || "input"}: ${issue.message}`
          : "Invalid input",
      );
    }
    const added = await McpAppService.add(
      ctx,
      parsed.data,
      principal.email || null,
      { allowPastedClient: false },
    );
    // The URL as the rules stored it.
    const row = await AppRepository.findById(added.rowId, ctx.orgId);
    const url = (row && remoteMcpBlockOf(row)?.url) ?? parsed.data.url;
    const gateway = setting("GATEWAY_URL")?.replace(/\/+$/, "") ?? "";
    const connect = added.connectPath ? `${gateway}${added.connectPath}` : null;
    let next: string;
    if (connect) {
      next = `Each member connects their own account at the connect link (open it in a browser); the Gateway lists the tools once someone has.`;
    } else if (added.setupCommand) {
      next =
        "The operator runs the command in a terminal and types the credential there, never into a chat. The Gateway lists the tools once it is set.";
    } else if (added.toolCount === null) {
      next = "The Gateway lists its tools on first use.";
    } else {
      next = `Its tools are on /mcp as ${added.appId}_<tool>.`;
    }
    return {
      id: added.appId,
      rowId: added.rowId,
      name: added.name,
      url,
      auth: added.credentialKind,
      ...(added.provider ? { provider: added.provider } : {}),
      ...(added.kind === "revived" ? { revived: true } : {}),
      credential: added.secret
        ? { name: added.secret, set: added.setupCommand === null }
        : null,
      ...(connect
        ? {
            connect: { url: connect },
          }
        : {}),
      ...(added.oauth ? { oauth: added.oauth } : {}),
      tools: added.toolCount,
      ...(added.setupCommand ? { setupCommand: added.setupCommand } : {}),
      next,
    };
  },

  async mcp_remove(ctx, args) {
    if (args["confirm"] !== true) {
      throw new PublicError(
        "INVALID_INPUT",
        "confirm: true is required; this cannot be undone",
      );
    }
    const details = await detailsOf(ctx, args);
    const credential = details.credential;
    await McpAppService.remove(ctx, { id: details.id });
    return {
      removed: {
        id: details.appId,
        rowId: details.id,
        name: details.name,
        kind: details.kind,
      },
      note: [
        "Its access, tokens, tools snapshot and place in AI connections are gone.",
        ...(credential?.own && credential.provider
          ? [
              `Its provider ${credential.provider} and its ${credential.kind === "oauth" ? "client and connections" : "key"} stay on the Gateway; ${SETUP_CLI} provider remove ${credential.provider}${credential.name ? ` and ${SETUP_CLI} secret unset ${credential.name}` : ""} clean up.`,
            ]
          : []),
      ].join(" "),
    };
  },

  async mcp_on(ctx, args) {
    const row = await resolveMcpApp(ctx, requireText(args, "app"));
    const { changed } = await McpAppService.setStatus(ctx, {
      id: row.id,
      status: "active",
    });
    const summary = summaryOf(await McpAppService.get(ctx, { id: row.id }));
    return { ...summary, changed };
  },

  async mcp_off(ctx, args) {
    const row = await resolveMcpApp(ctx, requireText(args, "app"));
    const { changed } = await McpAppService.setStatus(ctx, {
      id: row.id,
      status: "disabled",
    });
    return {
      id: row.appSlug,
      rowId: row.id,
      name: row.name,
      status: "off",
      changed,
    };
  },

  async mcp_refresh(ctx, args) {
    const row = await resolveMcpApp(ctx, requireText(args, "app"));
    const refreshed = await McpAppService.refreshTools(ctx, { id: row.id });
    return {
      id: row.appSlug,
      rowId: row.id,
      name: row.name,
      status: refreshed.status,
      tools: refreshed.toolCount,
      added: refreshed.added,
      removed: refreshed.removed,
      // Not `error`: the runner reads that as a refusal, and the snapshot
      // was dropped either way.
      ...(refreshed.error ? { problem: refreshed.error } : {}),
    };
  },

  async mcp_tool(ctx, args) {
    const ref = requireText(args, "tool");
    const risk = overrideRisk(args["risk"]);
    const enabled = args["enabled"];
    if (!("risk" in risk) && typeof enabled !== "boolean") {
      throw new PublicError("INVALID_INPUT", "Give risk, enabled, or both");
    }
    const details = await detailsOf(ctx, args);
    // The override is keyed by the server's own name; the tool is named by
    // either. One the last listing lacks is kept under the name given, and
    // applies once the server lists a tool by it (as `mcp tool` does).
    const match = details.tools.find(
      (tool) =>
        tool.listedName === ref ||
        tool.localName === ref ||
        tool.upstreamName === ref,
    );
    const serverName = match?.upstreamName ?? ref;
    // A built-in has no overrides: the service refuses it.
    const updated = await McpAppService.update(ctx, {
      id: details.id,
      tool: {
        name: serverName,
        override: {
          ...risk,
          ...(typeof enabled === "boolean" ? { enabled } : {}),
        },
      },
    });
    return {
      id: details.appId,
      tool: {
        serverName,
        name: match?.listedName ?? null,
        inListing: match?.listed === true,
      },
      override: updated.remote.tools[serverName] ?? null,
      rev: updated.remote.rev,
      note: match
        ? "The Gateway lists the tools again on first use."
        : "The server's last listing has no tool by that name; the override is kept under it and applies once the server lists one.",
    };
  },
};
