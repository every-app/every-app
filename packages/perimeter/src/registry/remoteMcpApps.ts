/**
 * The registry rules for remote MCP apps (`@every-app/sdk/internal`
 * remoteMcp.ts; docs/design/2026-10-mcp-by-url.md): a remote MCP server
 * the operator, an owner or an admin registers by URL as an MCP app of the
 * Gateway's own. Pure functions over rows the caller read, like
 * ./providerApps.ts: the CLI runs them against the Gateway's D1 under the
 * Cloudflare login (ADR-0003), the Gateway's server functions and
 * workspace tools run them in-process for owners and admins.
 *
 * A remote MCP app's row is a provider-tier row (no Worker, no hostname,
 * `active` from the start) whose manifest carries the `remote` block: the
 * one URL, the auth kind and the credential's setting NAME, the risk
 * default, the per-tool overrides and a revision. The same id as a
 * deployed app's or a built-in provider's is refused, tombstones included.
 * Who gets the app follows a deployed app's rule: the person adding it, the
 * owners and the admins; an admin grants others.
 *
 * `on` and `off` are the status, for both kinds of MCP app: `active`
 * serves, `disabled` keeps everything (access, tokens, the snapshot) and
 * serves nothing. `remove` is the tombstone (what `off` used to be).
 */
import {
  hasRemoteMcpBlock,
  isProviderAppId,
  parseRemoteMcpAuth,
  PROVIDER_APP_TIER,
  remoteMcpAppManifest,
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpOf,
  remoteMcpSecretName,
  remoteMcpUrlProblem,
  REMOTE_MCP_RISK_DEFAULTS,
  type RemoteMcpAuth,
  type RemoteMcpBlock,
  type RemoteMcpRiskDefault,
  type RemoteMcpToolOverride,
  type RemoteMcpUrlEnv,
} from "@every-app/sdk/internal";
import {
  DELETED_APP_STATUS,
  deleteUpdate,
  RegistrationError,
  type AccessGrant,
  type AppRow,
  type OrganizationMember,
} from "./registration";

export interface RemoteMcpAddInput {
  organizationId: string;
  /** The server's URL as given. */
  url: string;
  /** The app id; derived from the URL's host when absent. */
  id?: string | null;
  name?: string | null;
  description?: string | null;
  /** The auth block as given (`{ kind: "bearer" }` fills the default secret name). */
  auth?: unknown;
  risk?: string | null;
  /** The Gateway's environment the URL is checked against. */
  env: RemoteMcpUrlEnv;
  /** The organization's row for the id (tombstones included), once the id is known. */
  existingApp: (id: string) => AppRow | null;
  /**
   * The origin another live MCP app on this Gateway already sends the
   * credential name to, if one does (any organization: the Gateway has one
   * set of secrets). A name is bound to one origin; a second server at
   * another origin takes another name (`REMOTE_MCP_SECRET_TAKEN`).
   */
  secretUsedAt?: (secretName: string) => string | null;
  members: readonly OrganizationMember[];
  /** The member adding it, when the registrar is one. */
  actorUserId: string | null;
  /** Who added it, as the row records it (`deployed_by_actor`). */
  actor: string | null;
  now: number;
}

export interface RemoteMcpAddPlan {
  /** `new`: insert `app` and `grants`. `revived`: the id's own tombstone comes back as new. */
  kind: "new" | "revived";
  id: string;
  app: AppRow;
  grants: AccessGrant[];
  remote: RemoteMcpBlock;
}

function isOwnerOrAdmin(role: string | null): boolean {
  return (role ?? "")
    .split(",")
    .some((item) => ["owner", "admin"].includes(item.trim()));
}

function refuse(
  code: "REMOTE_MCP_INVALID" | "REMOTE_MCP_URL_REFUSED",
  message: string,
): never {
  throw new RegistrationError({ status: 400, code, message });
}

/** The auth block with the default secret name filled in for the id. */
function authFor(id: string, raw: unknown): RemoteMcpAuth {
  const given =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { kind: raw ?? "none" };
  const kind = given["kind"];
  const withDefault =
    (kind === "bearer" || kind === "header" || kind === "basic") &&
    given["secret"] === undefined
      ? { ...given, secret: remoteMcpSecretName(id) }
      : given;
  const parsed = parseRemoteMcpAuth(withDefault);
  if (!parsed.ok) refuse("REMOTE_MCP_INVALID", parsed.problem);
  return parsed.auth;
}

/** A remote MCP app's row is a provider-tier row with a `remote` block. */
export function isRemoteMcpRow(
  app: Pick<AppRow, "tier" | "manifest">,
): boolean {
  if (app.tier !== PROVIDER_APP_TIER || !app.manifest) return false;
  try {
    return hasRemoteMcpBlock(JSON.parse(app.manifest));
  } catch {
    return false;
  }
}

/** An MCP app's row of either kind: a built-in provider's or a remote server's. */
export function isMcpAppRow(app: Pick<AppRow, "tier">): boolean {
  return app.tier === PROVIDER_APP_TIER;
}

/** The stored `remote` block of a row, or null (a built-in's row, or an unreadable block). */
export function remoteMcpBlockOf(
  app: Pick<AppRow, "tier" | "manifest">,
): RemoteMcpBlock | null {
  if (app.tier !== PROVIDER_APP_TIER || !app.manifest) return null;
  try {
    return remoteMcpOf(JSON.parse(app.manifest));
  } catch {
    return null;
  }
}

/** The id's row must be this organization's and this id's. */
function assertRowMatches(
  organizationId: string,
  id: string,
  existingApp: AppRow | null,
): void {
  if (
    existingApp &&
    (existingApp.organizationId !== organizationId ||
      existingApp.appSlug !== id)
  ) {
    throw new Error("existingApp is another organization's or app's row.");
  }
}

/** A row that isn't a remote MCP app's: a deployed app's, or the built-in's. */
function assertRemoteRow(id: string, existingApp: AppRow): void {
  if (isRemoteMcpRow(existingApp)) return;
  const what =
    existingApp.tier === PROVIDER_APP_TIER
      ? "the Gateway's built-in MCP app"
      : `an app deployed to this Gateway${existingApp.status === DELETED_APP_STATUS ? " (deleted, its names still its organization's)" : ""}`;
  throw new RegistrationError({
    status: 409,
    code: "APP_TIER_MISMATCH",
    message: `"${id}" is ${what}; a remote MCP server can't take its id.`,
  });
}

/**
 * Register a remote MCP server: what to write, from the input and the
 * organization's row for the id (if any) and its members. Refuses a URL
 * the rules refuse (`REMOTE_MCP_URL_REFUSED`), a bad id, auth block or
 * risk (`REMOTE_MCP_INVALID`), an id in use (`APP_TIER_MISMATCH` for a
 * deployed app's or the built-in's; `REMOTE_MCP_EXISTS` for a remote app
 * that is on or off already: edit or remove it instead).
 */
export function planRemoteMcpAppAdd(
  input: RemoteMcpAddInput,
): RemoteMcpAddPlan {
  const url = input.url.trim();
  const urlProblem = remoteMcpUrlProblem(url, input.env);
  if (urlProblem) refuse("REMOTE_MCP_URL_REFUSED", urlProblem);
  const id = (input.id ?? "").trim() || remoteMcpIdFromUrl(url);
  if (!id) {
    refuse(
      "REMOTE_MCP_INVALID",
      "no app id could be read from the URL's host; give one with --name",
    );
  }
  const idProblem = remoteMcpIdProblem(id);
  if (idProblem) refuse("REMOTE_MCP_INVALID", idProblem);
  const risk = (input.risk ?? "annotations").trim();
  if (!(REMOTE_MCP_RISK_DEFAULTS as readonly string[]).includes(risk)) {
    refuse(
      "REMOTE_MCP_INVALID",
      `risk must be one of ${REMOTE_MCP_RISK_DEFAULTS.join(", ")}`,
    );
  }
  const auth = authFor(id, input.auth);
  if ("secret" in auth && input.secretUsedAt) {
    const usedAt = input.secretUsedAt(auth.secret);
    const origin = new URL(url).origin;
    if (usedAt && usedAt !== origin) {
      throw new RegistrationError({
        status: 409,
        code: "REMOTE_MCP_SECRET_TAKEN",
        message: `${auth.secret} is the credential of an MCP app at ${usedAt}; a server at ${origin} takes another name (--secret <NAME>_MCP_TOKEN).`,
      });
    }
  }
  const remote: RemoteMcpBlock = {
    url,
    auth,
    risk: risk as RemoteMcpRiskDefault,
    tools: {},
    rev: 1,
  };
  const manifest = remoteMcpAppManifest({
    id,
    name: input.name,
    description: input.description,
    remote,
  });

  const existingApp = input.existingApp(id);
  assertRowMatches(input.organizationId, id, existingApp);
  if (existingApp) {
    if (isProviderAppId(id) || !isRemoteMcpRow(existingApp)) {
      assertRemoteRow(id, existingApp);
    }
    if (existingApp.status !== DELETED_APP_STATUS) {
      throw new RegistrationError({
        status: 409,
        code: "REMOTE_MCP_EXISTS",
        message: `"${id}" is an MCP app on this Gateway already (${existingApp.status === "active" ? "on" : "off"}); remove it first, or change it in place.`,
      });
    }
  }
  const rowId = existingApp?.id ?? crypto.randomUUID();
  const app: AppRow = {
    id: rowId,
    organizationId: input.organizationId,
    appSlug: id,
    name: manifest.name,
    description: manifest.description,
    hostname: null,
    workerName: null,
    tier: PROVIDER_APP_TIER,
    scope: "org",
    manifest: JSON.stringify(manifest),
    status: "active",
    versionId: null,
    deployedAt: input.now,
    deployedByActor: input.actor,
    isDefault: false,
  };
  const grants: AccessGrant[] = input.members
    .filter(
      (member) =>
        member.id === input.actorUserId || isOwnerOrAdmin(member.role),
    )
    .map((member) => ({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: member.id,
      appRowId: rowId,
      grantedBy: null,
    }));
  return { kind: existingApp ? "revived" : "new", id, app, grants, remote };
}

export interface RemoteMcpChange {
  /** The whole override map replaces the stored one. */
  tools?: Record<string, RemoteMcpToolOverride>;
  /** One tool's override merged into the stored map (`null` clears it). */
  tool?: { name: string; override: RemoteMcpToolOverride | null };
  risk?: string;
  name?: string | null;
  description?: string | null;
}

/**
 * Change a remote MCP app in place: the risk default, the overrides (all,
 * or one tool's), the name or the description. The URL and the auth are
 * not changed here: a server at another address is another app (and a
 * changed address would move a credential; see the binding in the
 * design). Returns the updated manifest JSON and the row fields to write,
 * with `rev` bumped so the Gateway re-lists on first use.
 */
export function remoteMcpAppUpdate(
  app: AppRow,
  change: RemoteMcpChange,
): {
  manifest: string;
  name: string;
  description: string;
  remote: RemoteMcpBlock;
} {
  const current = remoteMcpBlockOf(app);
  if (!current) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" is not a remote MCP app.`,
    });
  }
  if (app.status === DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" was removed.`,
    });
  }
  let risk: RemoteMcpRiskDefault = current.risk;
  if (change.risk !== undefined) {
    if (
      !(REMOTE_MCP_RISK_DEFAULTS as readonly string[]).includes(change.risk)
    ) {
      refuse(
        "REMOTE_MCP_INVALID",
        `risk must be one of ${REMOTE_MCP_RISK_DEFAULTS.join(", ")}`,
      );
    }
    risk = change.risk as RemoteMcpRiskDefault;
  }
  let tools = { ...current.tools };
  if (change.tools) tools = { ...change.tools };
  if (change.tool) {
    const { name, override } = change.tool;
    if (!name.trim()) refuse("REMOTE_MCP_INVALID", "name the tool");
    if (override === null) {
      delete tools[name];
    } else {
      const merged = { ...tools[name], ...override };
      if (merged.risk === undefined) delete merged.risk;
      if (merged.enabled === undefined || merged.enabled === true) {
        delete merged.enabled;
      }
      if (Object.keys(merged).length === 0) delete tools[name];
      else tools[name] = merged;
    }
  }
  const remote: RemoteMcpBlock = {
    ...current,
    risk,
    tools,
    rev: current.rev + 1,
  };
  const stored = JSON.parse(app.manifest ?? "{}") as Record<string, unknown>;
  const manifest = remoteMcpAppManifest({
    id: app.appSlug,
    name: change.name === undefined ? app.name : change.name,
    description:
      change.description === undefined ? app.description : change.description,
    remote,
  });
  // Keep anything else the stored manifest carried (none today).
  const next = { ...stored, ...manifest };
  return {
    manifest: JSON.stringify(next),
    name: manifest.name,
    description: manifest.description,
    remote,
  };
}

export type McpAppStatus = "active" | "disabled";

/**
 * Turn an MCP app of either kind on or off: the status update to write,
 * or null when nothing changes (it is in that state already). A
 * tombstone or a row that isn't an MCP app's is refused: `on` after
 * `remove` is `add` again (or, for a built-in, `mcp on`, which revives it).
 */
export function mcpAppStatusUpdate(
  app: AppRow,
  status: McpAppStatus,
): { status: McpAppStatus } | null {
  if (!isMcpAppRow(app)) {
    throw new RegistrationError({
      status: 409,
      code: "APP_TIER_MISMATCH",
      message: `"${app.appSlug}" is an app deployed to this Gateway, not an MCP app.`,
    });
  }
  if (app.status === DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" was removed; add it again.`,
    });
  }
  if (app.status === status) return null;
  return { status };
}

/**
 * Remove an MCP app of either kind: the tombstone update to write (a
 * deleted app's, {@link deleteUpdate}; the caller drops everyone's access,
 * its tokens, its tools snapshot and its place in AI connections with
 * it), or null when there is nothing to remove: no row, a tombstone
 * already, or a deployed app's row, which this never touches.
 */
export function mcpAppRemoveUpdate(
  existingApp: AppRow | null,
): ReturnType<typeof deleteUpdate> {
  if (!existingApp || !isMcpAppRow(existingApp)) return null;
  return deleteUpdate(existingApp);
}
