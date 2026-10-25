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
 * `treg`) or its row id. No answer carries a credential: a remote server's
 * credential is the NAME of a Gateway setting, said with whether it is set
 * and bound, and the command the operator runs to set it in a terminal;
 * the origin a credential is bound to is never told (it may be another
 * server's).
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
 * The credential as the tools say it: its setting's name, whether the
 * Gateway has it set, and for a remote server whether it is bound to the
 * server's origin (`state` as McpAppService has it). Null when the app
 * takes none. A built-in's key is set by name and never bound.
 */
function credentialOf(details: McpAppDetails) {
  if (details.kind === "builtin") {
    if (!isProviderAppId(details.appId)) return null;
    const name = providerAppKeySetting(details.appId);
    const set = setting(name) !== null;
    return { name, set, state: set ? "set" : "not_set" };
  }
  const credential = details.credential;
  if (!credential?.name) return null;
  return {
    name: credential.name,
    set: credential.set,
    bound: credential.state === "bound",
    state: credential.state,
  };
}

/** The command that opens the app, while its credential needs setting. */
function setupCommandOf(
  details: McpAppDetails,
  credential: ReturnType<typeof credentialOf>,
): string | null {
  if (details.kind === "remote") return details.setupCommand;
  return credential && !credential.set
    ? secretSetCommand(credential.name)
    : null;
}

/**
 * On, off, or needs setup: on, but its credential isn't set or is bound to
 * another origin, or a remote app's stored block can't be read. A server
 * that wants OAuth reads as on or off, `supported: false` beside it, since
 * nothing can be set for it.
 */
function statusOf(
  details: McpAppDetails,
  credential: ReturnType<typeof credentialOf>,
): McpAppStatus {
  if (details.status !== "active") return "off";
  if (details.kind === "remote" && !details.remote) return "needs setup";
  if (credential && (!credential.set || credential.state === "bound_elsewhere"))
    return "needs setup";
  return "on";
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
    status: statusOf(details, credential),
    // The snapshot's count; null when never listed, or the last listing failed.
    tools:
      snapshot.status === null || snapshot.status === "error"
        ? null
        : snapshot.toolCount,
    ...(details.remote
      ? {
          url: details.remote.url,
          auth: details.remote.auth.kind,
          risk: details.remote.risk,
          supported: details.remote.auth.kind !== "oauth",
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
  if (value === "read" || value === "write" || value === "destructive") {
    return { risk: value };
  }
  throw new PublicError(
    "INVALID_INPUT",
    "risk is read, write, destructive or annotations",
  );
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
    );
    // The URL as the rules stored it.
    const row = await AppRepository.findById(added.rowId, ctx.orgId);
    const url = (row && remoteMcpBlockOf(row)?.url) ?? parsed.data.url;
    let next: string;
    if (added.authKind === "oauth") {
      next =
        "This server wants OAuth, which the Gateway doesn't serve yet: the app is kept and serves nothing.";
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
      auth: added.authKind,
      ...(added.kind === "revived" ? { revived: true } : {}),
      credential: added.secret
        ? { name: added.secret, set: added.setupCommand === null }
        : null,
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
    const credential = credentialOf(details);
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
        ...(credential?.set
          ? [
              `${credential.name} stays set on the Gateway; the operator unsets it with ${SETUP_CLI} secret unset ${credential.name}.`,
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
