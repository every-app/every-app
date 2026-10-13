import { env } from "cloudflare:workers";
import {
  isRegistryWorkerName,
  MAX_WORKER_NAME_LENGTH,
  registryWorkerNameFor,
  RESOURCE_SEPARATOR,
  resourceNameFor,
  validateManifest,
  ManifestError,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";
import {
  AppRepository,
  DELETED_APP_STATUS,
} from "@/server/repositories/AppRepository";
import { OrganizationKeyRepository } from "@/server/repositories/OrganizationKeyRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";

/**
 * The deploy-token side of the app registry. `everyapp app deploy` walks an
 * app through:
 *
 *   register ─▶ pending ─▶ deployed ─▶ binding ─▶ activate ─▶ active
 *
 * `pending` apps are never bound (their Worker may not exist yet) and
 * `binding` ones answer "deploying" until the gateway serves them over a
 * verified service binding. The gateway names everything: the Worker
 * `every-<orgKey>-<appId>` and its D1/KV resources after it
 * (`every-<orgKey>-<appId>--<binding>`), and the hostname, once, at first
 * registration. Which resources an app actually created, and so may adopt
 * or purge, the CLI records itself (`_everyapp_app_resources`).
 */

type RegisterAppInput = {
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  /**
   * The Worker name CLIs before org-scoped names derived themselves. It must
   * be the one the gateway assigns, or the app would deploy to another Worker.
   */
  workerName?: string;
  manifest: unknown;
  /** The user whose deploy token registers the app. */
  deployerUserId?: string | null;
};

/** The D1 databases and KV namespaces for an app's bindings, by binding. */
type AppResources = {
  d1: Record<string, string>;
  kv: Record<string, string>;
};

type RegisterAppResult = {
  /** The app's row id (kept under this name for older CLIs). */
  appId: string;
  appRowId: string;
  appSlug: string;
  status: string;
  workerName: string;
  hostname: string;
  legacyNames: boolean;
  resources: AppResources;
  /** The manifest of the code deployed before, to compare against. */
  previousManifest: unknown;
  /** The Worker version the last deploy uploaded; null before the first. */
  versionId: string | null;
  existingApp: boolean;
  defaultAccess: boolean;
  grantedUserCount: number;
};

type AppLocator = {
  organizationId: string;
  appSlug: string;
};

type AppDeployState = {
  status: string;
  workerName: string;
  hostname: string;
};

/** An app's state with the names of its resources. */
type AppDescription = AppDeployState & {
  /** Registered before org-scoped names: resource names use one hyphen. */
  legacyNames: boolean;
  resources: AppResources;
};

export class AppRegistrationError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor({
    message,
    status,
    code,
  }: {
    message: string;
    status: number;
    code?: string;
  }) {
    super(message);
    this.name = "AppRegistrationError";
    this.status = status;
    this.code = code;
  }
}

const DNS_LABEL_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ORG_KEY_MAX_LENGTH = 12;
const ORG_KEY_ATTEMPTS = 50;

function hostnameFor(appSlug: string, organizationSlug: string): string {
  if (!env.GATEWAY_URL) {
    throw new AppRegistrationError({
      status: 500,
      message:
        "Gateway has no GATEWAY_URL configured; cannot derive app hostname",
    });
  }

  let gatewayHost: string;
  try {
    gatewayHost = new URL(env.GATEWAY_URL).host.toLowerCase();
  } catch {
    throw new AppRegistrationError({
      status: 500,
      message:
        "Gateway has invalid GATEWAY_URL configured; cannot derive app hostname",
    });
  }

  const appLabel = `${appSlug.trim()}-${organizationSlug.trim()}`.toLowerCase();
  if (!DNS_LABEL_PATTERN.test(appLabel)) {
    throw new AppRegistrationError({
      status: 400,
      code: "INVALID_APP_HOSTNAME",
      message: `App id and organization slug must form a valid DNS label of at most 63 characters; received "${appLabel}".`,
    });
  }

  return `${appLabel}.${gatewayHost}`;
}

function validateRegistryManifest(
  rawManifest: unknown,
  appSlug: string,
): EveryAppManifest {
  try {
    const manifest = validateManifest(rawManifest);
    if (manifest.id !== appSlug) {
      throw new AppRegistrationError({
        status: 400,
        message: `manifest.id "${manifest.id}" does not match appId "${appSlug}"`,
      });
    }
    return manifest;
  } catch (error) {
    if (error instanceof AppRegistrationError) {
      throw error;
    }

    throw new AppRegistrationError({
      status: 400,
      message:
        error instanceof ManifestError ? error.message : "Invalid manifest",
    });
  }
}

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
 * The organization's key, given to it the first time it registers an app:
 * its slug's letters and digits, with a number on the end when another
 * organization already has them. It never changes after.
 */
async function orgKeyFor(
  organizationId: string,
  organizationSlug: string,
): Promise<string> {
  const existing =
    await OrganizationKeyRepository.findByOrganizationId(organizationId);
  if (existing) return existing;

  const base = orgKeyBaseFor(organizationSlug);
  for (let attempt = 1; attempt <= ORG_KEY_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? "" : String(attempt);
    const candidate = `${base.slice(0, ORG_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    const held = await OrganizationKeyRepository.claim(
      organizationId,
      candidate,
    );
    if (held) return held;
  }
  throw new AppRegistrationError({
    status: 500,
    code: "ORG_KEY_UNAVAILABLE",
    message: `Gateway could not give the organization a unique key based on "${base}".`,
  });
}

function resourcesFor(
  workerName: string,
  manifest: EveryAppManifest | null,
  legacyNames: boolean,
): AppResources {
  const names = (bindings: readonly string[] | undefined) =>
    Object.fromEntries(
      (bindings ?? []).map((binding) => [
        binding,
        resourceNameFor(workerName, binding, { legacyNames }),
      ]),
    );
  return {
    d1: names(manifest?.resources?.d1),
    kv: names(manifest?.resources?.kv),
  };
}

/** Two bindings of one kind that would share a database or namespace. */
function assertDistinctResources(resources: AppResources): void {
  for (const [kind, names] of Object.entries(resources)) {
    const seen = new Map<string, string>();
    for (const [binding, name] of Object.entries(names)) {
      const other = seen.get(name);
      if (other !== undefined) {
        throw new AppRegistrationError({
          status: 400,
          code: "RESOURCE_NAME_CONFLICT",
          message: `Bindings ${other} and ${binding} would share the ${kind === "d1" ? "D1 database" : "KV namespace"} "${name}". Rename one of them in everyapp.config.ts.`,
        });
      }
      seen.set(name, binding);
    }
  }
}

function parseStoredManifest(raw: string | null): EveryAppManifest | null {
  if (!raw) return null;
  try {
    return validateManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Who gets a newly registered app. Apps are private by default: the deployer
 * and the org's owners and admins, nobody added later. A manifest with
 * `access: "everyone"` grants every member and every future member instead.
 * Redeploys never change access; admins manage it in the gateway UI.
 */
async function initialAccess(
  data: RegisterAppInput,
  manifest: EveryAppManifest,
  appRowId: string,
) {
  const everyone = manifest.access === "everyone";
  const orgMembers =
    await OrganizationMembersRepository.listMembersForOrganization(
      data.organizationId,
    );
  const grantees = orgMembers.filter((member) => {
    if (everyone || member.id === data.deployerUserId) return true;
    const role = resolvePrimaryOrganizationRole(member.role);
    return role === "owner" || role === "admin";
  });
  return {
    isDefault: everyone,
    grants: grantees.map((member) => ({
      id: crypto.randomUUID(),
      organizationId: data.organizationId,
      userId: member.id,
      appRowId,
      grantedBy: null,
    })),
  };
}

/**
 * Register an app, or a redeploy of one. A new app (or a deleted one coming
 * back) starts `pending` with the names the gateway assigns it; a redeploy
 * keeps its names and status, and its manifest until the new code is up.
 */
async function register(data: RegisterAppInput): Promise<RegisterAppResult> {
  const manifest = validateRegistryManifest(data.manifest, data.appSlug);

  const organizationSlug = await OrganizationRepository.findSlugById(
    data.organizationId,
  );
  if (!organizationSlug) {
    throw new AppRegistrationError({
      status: 500,
      code: "ORGANIZATION_SLUG_NOT_FOUND",
      message: "Gateway could not resolve the deploying organization's slug",
    });
  }

  const existingApp = await AppRepository.findByAppSlug(
    data.appSlug,
    data.organizationId,
  );
  const legacyNames = existingApp?.legacyNames ?? false;
  if (!legacyNames && data.appSlug.includes(RESOURCE_SEPARATOR)) {
    throw new AppRegistrationError({
      status: 400,
      code: "INVALID_APP_ID",
      message: `App id "${data.appSlug}" can't contain "${RESOURCE_SEPARATOR}": it separates an app's Worker name from its resources' names. Choose another id.`,
    });
  }
  const orgKey = legacyNames
    ? null
    : await orgKeyFor(data.organizationId, organizationSlug);
  // Names are assigned once: a registered app keeps its own.
  const workerName =
    existingApp?.workerName ??
    registryWorkerNameFor({ appId: data.appSlug, orgKey, legacyNames });
  const hostname =
    existingApp?.hostname ?? hostnameFor(data.appSlug, organizationSlug);

  if (
    !isRegistryWorkerName({
      appId: data.appSlug,
      orgKey,
      legacyNames,
      workerName,
    })
  ) {
    throw new AppRegistrationError({
      status: 400,
      code: "INVALID_WORKER_NAME",
      message:
        workerName.length > MAX_WORKER_NAME_LENGTH
          ? `App id "${data.appSlug}" is too long: its Worker name "${workerName}" would exceed ${MAX_WORKER_NAME_LENGTH} characters.`
          : `App id "${data.appSlug}" can't be registered: its Worker would be "${workerName}", which is reserved for the gateway or isn't the app's own.`,
    });
  }
  if (data.workerName !== undefined && data.workerName !== workerName) {
    throw new AppRegistrationError({
      status: 409,
      code: "WORKER_NAME_MISMATCH",
      message: `This gateway names app Workers itself and assigned "${workerName}", not "${data.workerName}". Upgrade the everyapp CLI and deploy again.`,
    });
  }

  const [hostnameOwner, workerNameOwner] = await Promise.all([
    AppRepository.findByHostname(hostname),
    AppRepository.findByWorkerName(workerName),
  ]);
  const ownedByAnother = (
    owner: { organizationId: string; appSlug: string } | undefined,
  ) =>
    owner !== undefined &&
    (owner.organizationId !== data.organizationId ||
      owner.appSlug !== data.appSlug);
  if (ownedByAnother(hostnameOwner)) {
    throw new AppRegistrationError({
      status: 409,
      code: "HOSTNAME_TAKEN",
      message: `The hostname "${hostname}" is already registered to another app on this gateway.`,
    });
  }
  // Deleted apps keep their row (a tombstone), so their names stay taken.
  if (ownedByAnother(workerNameOwner)) {
    throw new AppRegistrationError({
      status: 409,
      code: "WORKER_NAME_TAKEN",
      message: `The worker name "${workerName}" is already registered to another app on this gateway. Choose a different app id.`,
    });
  }

  const resources = resourcesFor(workerName, manifest, legacyNames);
  assertDistinctResources(resources);

  const appRowId = existingApp?.id ?? crypto.randomUUID();
  const manifestJson = JSON.stringify(manifest);
  const result = {
    appId: appRowId,
    appRowId,
    appSlug: data.appSlug,
    workerName,
    hostname,
    legacyNames,
    resources,
    previousManifest: parseStoredManifest(existingApp?.manifest ?? null),
    versionId: existingApp?.versionId ?? null,
  };

  if (existingApp && existingApp.status !== DELETED_APP_STATUS) {
    await AppRepository.update(existingApp.id, {
      organizationId: data.organizationId,
      name: data.name,
      description: data.description,
      hostname,
      workerName,
    });

    return {
      ...result,
      status: existingApp.status,
      existingApp: true,
      defaultAccess: existingApp.isDefault,
      grantedUserCount: 0,
    };
  }

  const { isDefault, grants } = await initialAccess(data, manifest, appRowId);

  if (existingApp) {
    // Redeploying a deleted app restores its tombstone like a new app.
    await AppRepository.restoreWithInitialAccess(
      existingApp.id,
      {
        organizationId: data.organizationId,
        name: data.name,
        description: data.description,
        hostname,
        workerName,
        manifest: manifestJson,
        status: "pending",
        isDefault,
      },
      grants,
    );
  } else {
    try {
      await AppRepository.createWithInitialAccess(
        {
          id: appRowId,
          organizationId: data.organizationId,
          appSlug: data.appSlug,
          name: data.name,
          description: data.description,
          hostname,
          workerName,
          legacyNames,
          manifest: manifestJson,
          tier: "service_binding",
          status: "pending",
          isDefault,
        },
        grants,
      );
    } catch (error) {
      // Two concurrent registrations can both pass the read-side checks; the
      // unique indexes catch the loser. Surface that as the same 409 a serial
      // request would have received instead of an opaque 500.
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new AppRegistrationError({
          status: 409,
          code: "HOSTNAME_TAKEN",
          message: `The hostname "${hostname}" was just registered by another deploy on this gateway.`,
        });
      }
      throw error;
    }
  }

  return {
    ...result,
    status: "pending",
    existingApp: Boolean(existingApp),
    defaultAccess: isDefault,
    grantedUserCount: grants.length,
  };
}

async function findLiveApp({ organizationId, appSlug }: AppLocator) {
  const app = await AppRepository.findByAppSlug(appSlug, organizationId);
  if (!app || app.status === DELETED_APP_STATUS) {
    throw new AppRegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `No app "${appSlug}" is registered for this organization. Register it with \`everyapp app deploy\`.`,
    });
  }
  if (!app.workerName || !app.hostname) {
    throw new AppRegistrationError({
      status: 409,
      code: "APP_NOT_REGISTERED",
      message: `App "${appSlug}" has no Worker or hostname yet; deploy it again.`,
    });
  }
  return { ...app, workerName: app.workerName, hostname: app.hostname };
}

/**
 * The app's new Worker version is uploaded: record it with the manifest it
 * was built from (its route policy goes live now), and move a new app on to
 * `binding`, ready for the gateway to bind.
 */
async function markDeployed(
  locator: AppLocator & { versionId: string; manifest: unknown },
): Promise<AppDeployState> {
  const app = await findLiveApp(locator);
  const manifest = validateRegistryManifest(locator.manifest, locator.appSlug);
  const status =
    app.status === "pending" || app.status === "deploying"
      ? "binding"
      : app.status;
  await AppRepository.update(app.id, {
    organizationId: locator.organizationId,
    manifest: JSON.stringify(manifest),
    versionId: locator.versionId,
    deployedAt: new Date(),
    status,
  });
  return { status, workerName: app.workerName, hostname: app.hostname };
}

/**
 * Make the app live once the gateway can reach its Worker: `probe` checks
 * the gateway's service binding to it answers. Until the gateway version
 * with that binding serves everywhere, this refuses with
 * `BINDING_NOT_READY` and the CLI retries.
 */
async function activate(
  locator: AppLocator & {
    probe: (app: { workerName: string; hostname: string }) => Promise<boolean>;
  },
): Promise<AppDeployState> {
  const app = await findLiveApp(locator);
  if (app.status === "pending") {
    throw new AppRegistrationError({
      status: 409,
      code: "NOT_DEPLOYED",
      message: `App "${locator.appSlug}" has no uploaded Worker yet.`,
    });
  }
  const state = { workerName: app.workerName, hostname: app.hostname };
  if (app.status === "disabled") return { status: app.status, ...state };

  if (!(await locator.probe(state))) {
    throw new AppRegistrationError({
      status: 409,
      code: "BINDING_NOT_READY",
      message: `The gateway can't reach ${app.workerName} yet.`,
    });
  }
  if (app.status !== "active") {
    await AppRepository.update(app.id, {
      organizationId: locator.organizationId,
      status: "active",
    });
  }
  return { status: "active", ...state };
}

/**
 * Delete an app: its tombstone keeps its names reserved, and the next
 * gateway reconcile drops its binding. Deleting a deleted app again answers
 * the same, so the CLI can resume a purge.
 */
async function deleteApp(locator: AppLocator): Promise<AppDescription> {
  const app = await AppRepository.findByAppSlug(
    locator.appSlug,
    locator.organizationId,
  );
  if (!app?.workerName || !app.hostname) {
    throw new AppRegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `No app "${locator.appSlug}" is registered for this organization.`,
    });
  }
  if (app.status !== DELETED_APP_STATUS) {
    await AppRepository.tombstone(app.id, locator.organizationId);
  }
  return {
    status: DELETED_APP_STATUS,
    workerName: app.workerName,
    hostname: app.hostname,
    legacyNames: app.legacyNames,
    resources: resourcesFor(
      app.workerName,
      parseStoredManifest(app.manifest),
      app.legacyNames,
    ),
  };
}

/** An app's deploy state, Worker, hostname and resources. */
async function describe(locator: AppLocator): Promise<AppDescription> {
  const app = await findLiveApp(locator);
  return {
    status: app.status,
    workerName: app.workerName,
    hostname: app.hostname,
    legacyNames: app.legacyNames,
    resources: resourcesFor(
      app.workerName,
      parseStoredManifest(app.manifest),
      app.legacyNames,
    ),
  };
}

export const AppRegistrationService = {
  register,
  markDeployed,
  activate,
  delete: deleteApp,
  describe,
} as const;
