/**
 * The app registry's write rules, shared by everything that registers,
 * deploys or deletes an app: the CLI, which writes the gateway's D1 itself
 * in self-host (ADR-0003), and a hosted control plane later. Pure functions
 * over rows the caller reads and writes; no I/O, so they run in Workers and
 * in Node alike.
 *
 *   planRegistration ─▶ pending ─▶ markDeployedUpdate ─▶ binding ─▶ active
 *
 * `pending` apps are never bound (their Worker may not exist yet). A
 * `binding` app's Worker is uploaded, and the gateway makes it `active` on
 * the first request that reaches it over a service binding. Names are
 * assigned once, at first registration: the Worker `every-<orgKey>-<appId>`,
 * its D1, KV and R2 resources after it (`every-<orgKey>-<appId>--<binding>`), and
 * the hostname, `<appId>.<base>` for the install's own organization and
 * `<appId>-<orgKey>.<base>` for any other. Deleted apps keep their row (a
 * tombstone), so their names stay taken. A `shared` app (a first-party app
 * every organization's members may open, on the hosted gateway) is only
 * ever the install organization's, the platform organization there, and
 * keeps its scope for good.
 */
import type { AppScope, Tier } from "./apps";
import {
  bucketNameFor,
  isRegistryWorkerName,
  isReservedAppId,
  ManifestError,
  MAX_BUCKET_NAME_LENGTH,
  MAX_WORKER_NAME_LENGTH,
  registryWorkerNameFor,
  RESOURCE_SEPARATOR,
  resourceNameFor,
  validateManifest,
  type Manifest,
} from "../manifest/manifest";

/** The status of a deleted app's tombstone row. */
export const DELETED_APP_STATUS = "deleted";

/**
 * An `apps` row as the rules read and write it: its columns in camelCase
 * (`app_slug` is `appSlug`, `deployed_by_actor` is `deployedByActor`), with
 * `deployed_at` in epoch milliseconds and `is_default` as a boolean.
 */
export interface AppRow {
  id: string;
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  hostname: string | null;
  workerName: string | null;
  tier: string;
  /** `org` or `shared` (./apps.ts). */
  scope: string;
  /** JSON of the manifest the live code was built from. */
  manifest: string | null;
  /** JSON string[] of the app Worker's secret names as the CLI last recorded them; null: never. */
  secretNames?: string | null;
  status: string;
  versionId: string | null;
  deployedAt: number | null;
  deployedByActor: string | null;
  isDefault: boolean;
}

/** The row holding a hostname or Worker name, tombstones included. */
export type AppNameOwner = Pick<
  AppRow,
  "organizationId" | "appSlug" | "hostname" | "workerName"
>;

/** A `user_app_access` row to insert. */
export interface AccessGrant {
  id: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  grantedBy: null;
}

/** The D1 databases, KV namespaces and R2 buckets for an app's bindings, by binding. */
export type AppResources = {
  d1: Record<string, string>;
  kv: Record<string, string>;
  r2: Record<string, string>;
};

export type RegistrationErrorCode =
  | "RESERVED_APP_ID"
  | "INVALID_APP_ID"
  | "INVALID_MANIFEST"
  | "INVALID_APP_HOSTNAME"
  | "INVALID_WORKER_NAME"
  | "HOSTNAME_TAKEN"
  | "WORKER_NAME_TAKEN"
  | "RESOURCE_NAME_CONFLICT"
  | "ORG_KEY_UNAVAILABLE"
  | "APP_NOT_FOUND"
  | "APP_NOT_REGISTERED"
  | "SHARED_APP_NOT_PLATFORM"
  | "APP_SCOPE_MISMATCH"
  | "APP_TIER_MISMATCH";

/** A registration the rules refuse, with the HTTP status a server answers. */
export class RegistrationError extends Error {
  readonly status: number;
  readonly code: RegistrationErrorCode;

  constructor({
    status,
    code,
    message,
  }: {
    status: number;
    code: RegistrationErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "RegistrationError";
    this.status = status;
    this.code = code;
  }
}

const DNS_LABEL_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ORG_KEY_MAX_LENGTH = 12;
const ORG_KEY_ATTEMPTS = 50;

/** The `[a-z0-9]`, at most 12 characters, an organization's key starts as. */
export function orgKeyBaseFor(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, ORG_KEY_MAX_LENGTH) || "org"
  );
}

/**
 * The keys to try, in order, for an organization that has none: its slug's
 * letters and digits, then the same with 2, 3, … on the end (still at most
 * 12 characters). The caller claims the first one no other organization
 * holds (`organization_keys` is unique on both columns) and keeps it for
 * good; when all are taken it fails with `ORG_KEY_UNAVAILABLE`.
 */
export function orgKeyCandidates(organizationSlug: string): string[] {
  const base = orgKeyBaseFor(organizationSlug);
  return Array.from({ length: ORG_KEY_ATTEMPTS }, (_, index) => {
    const suffix = index === 0 ? "" : String(index + 1);
    return `${base.slice(0, ORG_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
  });
}

function hostLabel(label: string, parts: string): string {
  const appLabel = label.trim().toLowerCase();
  if (!DNS_LABEL_PATTERN.test(appLabel)) {
    throw new RegistrationError({
      status: 400,
      code: "INVALID_APP_HOSTNAME",
      message: `${parts} must form a valid DNS label of at most 63 characters; received "${appLabel}".`,
    });
  }
  return appLabel;
}

export interface AppNamesInput {
  appSlug: string;
  /** The organization's key (claim one from {@link orgKeyCandidates} first). */
  orgKey: string;
  /** Whether the app's organization is the install's own (the owner's). */
  isInstallOrganization: boolean;
  /** The install's base domain (`APP_BASE_DOMAIN`), e.g. `apps.example.com`. */
  appBaseDomain: string;
  /** The organization's row for this app id, tombstones included. */
  existingApp: Pick<AppRow, "hostname" | "workerName"> | null;
}

/**
 * The Worker name and hostname an app registers under: the ones its row
 * already has, else the ones the naming rules give it. The caller looks up
 * who holds them (`hostnameOwner`, `workerNameOwner`) before
 * {@link planRegistration}.
 */
export function appNames(input: AppNamesInput): {
  workerName: string;
  hostname: string;
} {
  const { appSlug, orgKey } = input;
  if (isReservedAppId(appSlug)) {
    // "everyapp" prefixes the gateway's own MCP tools.
    throw new RegistrationError({
      status: 400,
      code: "RESERVED_APP_ID",
      message: `The app id "${appSlug}" is reserved for the platform.`,
    });
  }
  if (appSlug.includes(RESOURCE_SEPARATOR)) {
    throw new RegistrationError({
      status: 400,
      code: "INVALID_APP_ID",
      message: `App id "${appSlug}" can't contain "${RESOURCE_SEPARATOR}": it separates an app's Worker name from its resources' names. Choose another id.`,
    });
  }

  const workerName =
    input.existingApp?.workerName ??
    registryWorkerNameFor({ appId: appSlug, orgKey });
  const base = input.appBaseDomain.trim().toLowerCase().replace(/\.$/, "");
  const hostname =
    input.existingApp?.hostname ??
    `${
      input.isInstallOrganization
        ? hostLabel(appSlug, "The app id")
        : hostLabel(`${appSlug}-${orgKey}`, "The app id and organization key")
    }.${base}`;

  if (!isRegistryWorkerName({ appId: appSlug, orgKey, workerName })) {
    throw new RegistrationError({
      status: 400,
      code: "INVALID_WORKER_NAME",
      message:
        workerName.length > MAX_WORKER_NAME_LENGTH
          ? `App id "${appSlug}" is too long: its Worker name "${workerName}" would exceed ${MAX_WORKER_NAME_LENGTH} characters.`
          : `App id "${appSlug}" can't be registered: its Worker would be "${workerName}", which is reserved for the gateway or isn't the app's own.`,
    });
  }
  return { workerName, hostname };
}

function validateRegistryManifest(raw: unknown, appSlug: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = validateManifest(raw);
  } catch (error) {
    throw new RegistrationError({
      status: 400,
      code: "INVALID_MANIFEST",
      message:
        error instanceof ManifestError ? error.message : "Invalid manifest",
    });
  }
  if (manifest.id !== appSlug) {
    throw new RegistrationError({
      status: 400,
      code: "INVALID_MANIFEST",
      message: `manifest.id "${manifest.id}" does not match appId "${appSlug}"`,
    });
  }
  return manifest;
}

/** A stored manifest, or null when there is none or it no longer parses. */
export function parseStoredManifest(raw: string | null): Manifest | null {
  if (!raw) return null;
  try {
    return validateManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

function resourcesFor(
  workerName: string,
  manifest: Manifest | null,
): AppResources {
  const names = (
    bindings: readonly string[] | undefined,
    nameFor: (workerName: string, binding: string) => string = resourceNameFor,
  ) =>
    Object.fromEntries(
      (bindings ?? []).map((binding) => [
        binding,
        nameFor(workerName, binding),
      ]),
    );
  return {
    d1: names(manifest?.resources?.d1),
    kv: names(manifest?.resources?.kv),
    r2: names(manifest?.resources?.r2, bucketNameFor),
  };
}

/**
 * The resources a registered app's bindings use, from its row: what a purge
 * deletes (only those the resource ledger records as the app's own).
 */
export function appResources(
  app: Pick<AppRow, "workerName" | "manifest">,
): AppResources {
  if (!app.workerName) return { d1: {}, kv: {}, r2: {} };
  return resourcesFor(app.workerName, parseStoredManifest(app.manifest));
}

const RESOURCE_LABELS: Record<keyof AppResources, string> = {
  d1: "D1 database",
  kv: "KV namespace",
  r2: "R2 bucket",
};

/**
 * Cloudflare's rule for an R2 bucket's name: lowercase letters, digits and
 * hyphens, starting and ending with a letter or digit.
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Two bindings of one kind that would share a database, namespace or
 * bucket, or a bucket name Cloudflare refuses.
 */
function assertDistinctResources(resources: AppResources): void {
  for (const [kind, names] of Object.entries(resources) as Array<
    [keyof AppResources, Record<string, string>]
  >) {
    const seen = new Map<string, string>();
    for (const [binding, name] of Object.entries(names)) {
      const other = seen.get(name);
      if (other !== undefined) {
        throw new RegistrationError({
          status: 400,
          code: "RESOURCE_NAME_CONFLICT",
          message: `Bindings ${other} and ${binding} would share the ${RESOURCE_LABELS[kind]} "${name}". Rename one of them in everyapp.config.ts.`,
        });
      }
      if (
        kind === "r2" &&
        (name.length > MAX_BUCKET_NAME_LENGTH || !BUCKET_NAME.test(name))
      ) {
        throw new RegistrationError({
          status: 400,
          code: "INVALID_MANIFEST",
          message: `resources.r2: ${binding} would be the R2 bucket "${name}", which Cloudflare refuses (at most ${MAX_BUCKET_NAME_LENGTH} lowercase letters, digits and hyphens, starting and ending with a letter or digit). Rename the binding in everyapp.config.ts.`,
        });
      }
      seen.set(name, binding);
    }
  }
}

function isOwnerOrAdmin(role: string | null): boolean {
  return (role ?? "")
    .split(",")
    .some((item) => ["owner", "admin"].includes(item.trim()));
}

export interface OrganizationMember {
  /** The user's id. */
  id: string;
  /** `members.role`: one role, or several comma-separated. */
  role: string | null;
}

export interface RegistrationInput {
  organizationId: string;
  isInstallOrganization: boolean;
  /**
   * `shared` registers a first-party app for every organization (only the
   * install organization's), `org` the organization's own. Unset keeps the
   * scope of the app's row, so a redeploy (`secret set`, a plain `deploy`)
   * keeps its shape; a new app is `org`.
   */
  scope?: AppScope;
  /**
   * How the gateway reaches the app: `dispatch` for a third-party app in
   * the hosted gateway's dispatch namespace (the deploy API), otherwise a
   * service binding. A registered app keeps its tier: asking for another
   * is refused, tombstones included.
   */
  tier?: Tier;
  appSlug: string;
  name: string;
  description: string;
  /** The manifest the deploy builds from (`everyapp.config.ts`). */
  manifest: unknown;
  appBaseDomain: string;
  /** The organization's key; see {@link orgKeyCandidates}. */
  orgKey: string;
  /** The organization's row for this app id, tombstones included. */
  existingApp: AppRow | null;
  /** The row holding {@link appNames}' hostname, tombstones included. */
  hostnameOwner: AppNameOwner | null;
  /** The row holding {@link appNames}' Worker name, tombstones included. */
  workerNameOwner: AppNameOwner | null;
  /** The organization's members, for a new app's initial access. */
  members: readonly OrganizationMember[];
  /** The member deploying, when the deployer is one. */
  deployerUserId: string | null;
}

export interface RegistrationPlan {
  /**
   * `new`: insert `app`. `revived`: a deleted app's own organization deploys
   * it again; update its tombstone to `app`. Both start `pending` and insert
   * `grants`. `existing`: update `app`'s name and description; nothing else
   * changes until the new code is uploaded ({@link markDeployedUpdate}).
   */
  kind: "new" | "revived" | "existing";
  /** The whole row as it is to be written. */
  app: AppRow;
  /** The `user_app_access` rows to insert with it (none for `existing`). */
  grants: AccessGrant[];
  resources: AppResources;
  /** The manifest of the code deployed before, to compare against. */
  previousManifest: Manifest | null;
  /** The Worker version the last deploy uploaded; null before the first. */
  versionId: string | null;
}

/**
 * Who gets a newly registered app. Apps are private by default: the deployer
 * and the org's owners and admins, nobody added later. A manifest with
 * `access: "everyone"` grants every member and every future member instead
 * (`is_default`). Redeploys never change access; admins manage it in the
 * gateway UI. Before the gateway has an owner there is nobody to grant; the
 * setup claim gives the first owner every app nobody has access to.
 */
function initialAccess(
  input: RegistrationInput,
  scope: AppScope,
  manifest: Manifest,
  appRowId: string,
): { isDefault: boolean; grants: AccessGrant[] } {
  // Membership of any active organization opens a shared app: nobody is
  // granted it, and it is no organization's default.
  if (scope === "shared") return { isDefault: false, grants: [] };
  const everyone = manifest.access === "everyone";
  return {
    isDefault: everyone,
    grants: input.members
      .filter(
        (member) =>
          everyone ||
          member.id === input.deployerUserId ||
          isOwnerOrAdmin(member.role),
      )
      .map((member) => ({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        userId: member.id,
        appRowId,
        grantedBy: null,
      })),
  };
}

/**
 * Register an app, or a redeploy of one: check the rules against the rows
 * the caller read, and return what to write in one batch. A new app (or a
 * deleted one coming back) starts `pending` with the names the rules assign
 * it; a redeploy keeps its names, status and live manifest. A shared app is
 * the install organization's only, and an app's scope never changes: an
 * unset scope keeps the row's, and the same id asked for as the other scope
 * is refused, tombstones included (delete it and register another id).
 */
export function planRegistration(input: RegistrationInput): RegistrationPlan {
  const { existingApp } = input;
  // A row's scope the rules don't know is refused below, as a mismatch.
  const scope: AppScope =
    input.scope ?? (existingApp?.scope === "shared" ? "shared" : "org");
  if (
    existingApp &&
    (existingApp.organizationId !== input.organizationId ||
      existingApp.appSlug !== input.appSlug)
  ) {
    throw new Error("existingApp is another organization's or app's row.");
  }
  if (scope === "shared" && !input.isInstallOrganization) {
    throw new RegistrationError({
      status: 403,
      code: "SHARED_APP_NOT_PLATFORM",
      message: `Only the platform organization registers shared apps; "${input.appSlug}" can't be shared from another organization.`,
    });
  }
  if (existingApp && existingApp.scope !== scope) {
    throw new RegistrationError({
      status: 409,
      code: "APP_SCOPE_MISMATCH",
      message:
        existingApp.scope === "shared"
          ? `App "${input.appSlug}" is a shared app, not this organization's own. Deploy it without asking for another scope, or give the organization's own app an id of its own.`
          : `App "${input.appSlug}" is this organization's own app, not a shared one. Shared apps need an app id of their own.`,
    });
  }
  const tier: Tier = input.tier ?? "service_binding";
  if (tier === "dispatch" && scope === "shared") {
    // First-party apps are ours, in our account: never customer code.
    throw new RegistrationError({
      status: 400,
      code: "APP_TIER_MISMATCH",
      message: `A shared app is reached over a service binding; "${input.appSlug}" can't be deployed through the hosted deploy API.`,
    });
  }
  if (existingApp && existingApp.tier !== tier) {
    throw new RegistrationError({
      status: 409,
      code: "APP_TIER_MISMATCH",
      message:
        existingApp.tier === "dispatch"
          ? `App "${input.appSlug}" is deployed through the hosted deploy API; deploy it the same way, or give this app an id of its own.`
          : `App "${input.appSlug}" is reached over a service binding, not deployed through the hosted deploy API; give the third-party app an id of its own.`,
    });
  }
  // Reserved and malformed ids first, as appNames would refuse them.
  const names = appNames(input);
  const manifest = validateRegistryManifest(input.manifest, input.appSlug);
  const { workerName, hostname } = names;

  for (const [owner, column, name] of [
    [input.hostnameOwner, "hostname", hostname],
    [input.workerNameOwner, "workerName", workerName],
  ] as const) {
    if (owner && owner[column] !== name) {
      throw new Error(`The ${column} owner passed holds another ${column}.`);
    }
  }
  const ownedByAnother = (owner: AppNameOwner | null) =>
    owner !== null &&
    (owner.organizationId !== input.organizationId ||
      owner.appSlug !== input.appSlug);
  if (ownedByAnother(input.hostnameOwner)) {
    throw new RegistrationError({
      status: 409,
      code: "HOSTNAME_TAKEN",
      message: `The hostname "${hostname}" is already registered to another app on this gateway.`,
    });
  }
  if (ownedByAnother(input.workerNameOwner)) {
    throw new RegistrationError({
      status: 409,
      code: "WORKER_NAME_TAKEN",
      message: `The worker name "${workerName}" is already registered to another app on this gateway. Choose a different app id.`,
    });
  }

  const resources = resourcesFor(workerName, manifest);
  assertDistinctResources(resources);

  const common = {
    organizationId: input.organizationId,
    name: input.name,
    description: input.description,
    hostname,
    workerName,
  };
  const previous = {
    previousManifest: parseStoredManifest(existingApp?.manifest ?? null),
    versionId: existingApp?.versionId ?? null,
    resources,
  };

  if (existingApp && existingApp.status !== DELETED_APP_STATUS) {
    return {
      kind: "existing",
      app: { ...existingApp, ...common },
      grants: [],
      ...previous,
    };
  }

  const appRowId = existingApp?.id ?? crypto.randomUUID();
  const { isDefault, grants } = initialAccess(input, scope, manifest, appRowId);
  const started = {
    ...common,
    manifest: JSON.stringify(manifest),
    status: "pending",
    isDefault,
  };
  return existingApp
    ? {
        kind: "revived",
        app: { ...existingApp, ...started },
        grants,
        ...previous,
      }
    : {
        kind: "new",
        app: {
          id: appRowId,
          appSlug: input.appSlug,
          tier,
          scope,
          versionId: null,
          deployedAt: null,
          deployedByActor: null,
          ...started,
        },
        grants,
        ...previous,
      };
}

/** The columns {@link markDeployedUpdate} writes. */
export interface DeployedUpdate {
  manifest: string;
  versionId: string;
  /** Epoch milliseconds. */
  deployedAt: number;
  deployedByActor: string;
  status: string;
}

/**
 * A dispatch app may have no hostname: the hosted gateway names it on the
 * third-party domain only once one is set. It is uploaded and verified all
 * the same, and unreachable until then.
 */
type DeployableApp = Pick<
  AppRow,
  "appSlug" | "status" | "hostname" | "workerName"
> & { tier?: string };

function assertLiveApp(app: DeployableApp): void {
  if (app.status === DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `No app "${app.appSlug}" is registered for this organization.`,
    });
  }
  if (!app.workerName || (!app.hostname && app.tier !== "dispatch")) {
    throw new RegistrationError({
      status: 409,
      code: "APP_NOT_REGISTERED",
      message: `App "${app.appSlug}" has no Worker or hostname yet; deploy it again.`,
    });
  }
}

/**
 * The app's new Worker version is uploaded: record it with the manifest it
 * was built from (its route policy goes live now) and who deployed it (the
 * Cloudflare login's email, or `api-token:<account id>`). A new app moves on
 * to `binding`, for the gateway to activate; any other status stays.
 */
export function markDeployedUpdate(
  app: DeployableApp,
  {
    versionId,
    manifest,
    actor,
    now = Date.now(),
  }: { versionId: string; manifest: unknown; actor: string; now?: number },
): DeployedUpdate {
  assertLiveApp(app);
  return {
    manifest: JSON.stringify(validateRegistryManifest(manifest, app.appSlug)),
    versionId,
    deployedAt: now,
    deployedByActor: actor,
    status: app.status === "pending" ? "binding" : app.status,
  };
}

/**
 * The columns that make an app a tombstone: unrouted and unlisted, its
 * names still reserved to its organization, no longer available to
 * everyone, and its email configuration (`email_senders`, `email_inbound`)
 * and recorded secret names gone, so a revived app starts without them. Null for an app that already
 * is one, so a resumed delete writes nothing. With it go, in the same
 * batch: everyone's `user_app_access` to it, the `user_access_tokens`
 * bound to it (revoked), its `app_tools` and `app_tool_catalogs` rows, and
 * its `mcp_connection_apps` rows.
 */
export function deleteUpdate(app: Pick<AppRow, "status">): {
  status: typeof DELETED_APP_STATUS;
  isDefault: false;
  emailSenders: null;
  emailInbound: null;
  secretNames: null;
} | null {
  if (app.status === DELETED_APP_STATUS) return null;
  return {
    status: DELETED_APP_STATUS,
    isDefault: false,
    emailSenders: null,
    emailInbound: null,
    secretNames: null,
  };
}
