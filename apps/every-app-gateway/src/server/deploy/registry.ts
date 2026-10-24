/**
 * Registry rows written by the Gateway's release deployer:
 * on the hosted gateway the deploy API is the control plane, so the rules
 * the CLI runs over D1 in self-host (@every-app/perimeter/registry) run
 * here instead, with the tier `dispatch` and the organization's own scope.
 * A third-party app is named like any other organization's app: its Worker
 * `every-<orgKey>-<appId>` (the only name getAppFetcher dispatches to), its
 * D1 `<worker>--<binding>`, and its hostname `<appId>-<orgKey>.<domain>`
 * on the third-party domain (THIRD_PARTY_DOMAIN), never the gateway's own.
 * With no third-party domain set the app gets no hostname: it is uploaded
 * and verified, and nobody can open it until a later deploy names it.
 * Self-hosted installs use service_binding and the CLI's install-org
 * naming rules on APP_BASE_DOMAIN instead.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  appNames,
  markDeployedUpdate,
  orgKeyCandidates,
  planRegistration,
  RegistrationError,
  type AppRow,
  type RegistrationPlan,
} from "@every-app/perimeter/registry";
import { db } from "@/db";
import {
  apps,
  members,
  organizationKeys,
  organizations,
  userAppAccess,
} from "@/db/schema";
import { DeployError } from "./errors";

type StoredApp = typeof apps.$inferSelect;

/**
 * The rules need a base domain to check the app id makes a DNS label;
 * with no third-party domain they check it under the reserved `.invalid`
 * (RFC 2606), and the row keeps no hostname.
 */
const NO_DOMAIN = "third-party.invalid";

export function toAppRow(row: StoredApp): AppRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    appSlug: row.appSlug,
    name: row.name,
    description: row.description,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier,
    scope: row.scope,
    manifest: row.manifest,
    status: row.status,
    versionId: row.versionId,
    deployedAt: row.deployedAt?.getTime() ?? null,
    deployedByActor: row.deployedByActor,
    isDefault: row.isDefault,
  };
}

function asDeployError(error: unknown): unknown {
  if (error instanceof RegistrationError) {
    return new DeployError(error.code, error.status, error.message);
  }
  return error;
}

/** The organization's key, claimed now if it has none. */
async function orgKeyFor(organizationId: string): Promise<string> {
  const current = async () =>
    (
      await db
        .select({ orgKey: organizationKeys.orgKey })
        .from(organizationKeys)
        .where(eq(organizationKeys.organizationId, organizationId))
    )[0]?.orgKey;
  const existing = await current();
  if (existing) return existing;
  const [organization] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization) {
    throw new DeployError(
      "ORGANIZATION_NOT_FOUND",
      404,
      "No such organization.",
    );
  }
  for (const candidate of orgKeyCandidates(organization.slug)) {
    // Unique on both columns: a key another organization holds, or a
    // second key for this one, inserts nothing.
    await db
      .insert(organizationKeys)
      .values({ organizationId, orgKey: candidate })
      .onConflictDoNothing();
    const claimed = await current();
    if (claimed) return claimed;
  }
  throw new DeployError(
    "ORG_KEY_UNAVAILABLE",
    409,
    `Every key for organization "${organization.slug}" is taken by another organization on this gateway.`,
  );
}

/** The organization's row for an app id, tombstones included. */
export async function findOrgApp(
  organizationId: string,
  appSlug: string,
): Promise<StoredApp | null> {
  const [row] = await db
    .select()
    .from(apps)
    .where(
      and(eq(apps.organizationId, organizationId), eq(apps.appSlug, appSlug)),
    );
  return row ?? null;
}

interface RegisterDispatchAppInput {
  /** Self-hosted installs use the CLI's normal service-binding tier. */
  serviceBinding?: boolean;
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  manifest: unknown;
  deployerUserId: string;
  /** THIRD_PARTY_DOMAIN as set: one on, under or above appBaseDomain is refused. */
  configuredThirdPartyDomain: string | null;
  /** The gateway's own APP_BASE_DOMAIN (appBaseDomain(env)). */
  appBaseDomain: string | null;
  /** The domain apps are named on: thirdPartyDomain(env), null without a valid one. */
  thirdPartyDomain: string | null;
}

/**
 * Third-party code never gets a host on, under or above the gateway's own
 * domain: the gateway's session cookie is scoped there, and a host above it
 * could set cookies the gateway reads. A sibling under one registrable
 * domain isn't caught here; the runbook asks for a registrable domain.
 */
function assertOwnDomain(domain: string, appBase: string | null): void {
  const third = domain.replace(/\.$/, "");
  if (
    appBase &&
    (third === appBase ||
      third.endsWith(`.${appBase}`) ||
      appBase.endsWith(`.${third}`))
  ) {
    throw new DeployError(
      "DEPLOYER_NOT_CONFIGURED",
      503,
      `THIRD_PARTY_DOMAIN (${third}) overlaps the gateway's own domain (${appBase}); third-party apps need a registrable domain of their own.`,
    );
  }
}

/**
 * Register a third-party app, or the next deploy of one: a new app is
 * `pending` and granted to the deployer and the organization's owners and
 * admins (or everyone, with `access: "everyone"`); a registered one keeps
 * its names, status and live manifest, takes the manifest's name and
 * description, and gains its hostname once the gateway has a third-party
 * domain.
 */
export async function registerDispatchApp(
  input: RegisterDispatchAppInput,
): Promise<RegistrationPlan> {
  try {
    return await register(input);
  } catch (error) {
    throw asDeployError(error);
  }
}

async function register(
  input: RegisterDispatchAppInput,
): Promise<RegistrationPlan> {
  const { organizationId, appSlug } = input;
  const configured =
    input.configuredThirdPartyDomain?.trim().toLowerCase() || null;
  if (!input.serviceBinding && configured)
    assertOwnDomain(configured, input.appBaseDomain);
  const domain = input.serviceBinding
    ? input.appBaseDomain
    : input.thirdPartyDomain;
  if (input.serviceBinding && !domain)
    throw new DeployError(
      "DEPLOYER_NOT_CONFIGURED",
      503,
      "Set APP_BASE_DOMAIN before installing apps.",
    );
  const owned = input.serviceBinding
    ? ((await db.all(
        sql`SELECT id FROM organizations WHERE EXISTS (SELECT 1 FROM members WHERE members.organization_id = organizations.id AND members.role = 'owner') ORDER BY created_at, id LIMIT 1`,
      )) as Array<{ id: string }>)
    : [];
  const isInstallOrganization =
    input.serviceBinding === true && owned[0]?.id === organizationId;
  const orgKey = await orgKeyFor(organizationId);
  const stored = await findOrgApp(organizationId, appSlug);
  const existingApp = stored ? toAppRow(stored) : null;
  const names = appNames({
    appSlug,
    orgKey,
    // The bare app id belongs only to the self-hosted install organization.
    isInstallOrganization,
    appBaseDomain: domain ?? NO_DOMAIN,
    existingApp,
  });
  const owner = async (
    column: typeof apps.hostname | typeof apps.workerName,
    value: string,
  ) => {
    const [row] = await db.select().from(apps).where(eq(column, value));
    return row ? toAppRow(row) : null;
  };
  const orgMembers = await db
    .select({ id: members.userId, role: members.role })
    .from(members)
    .where(eq(members.organizationId, organizationId));
  const plan = planRegistration({
    organizationId,
    isInstallOrganization,
    scope: "org",
    tier: input.serviceBinding ? "service_binding" : "dispatch",
    appSlug,
    name: input.name,
    description: input.description,
    manifest: input.manifest,
    appBaseDomain: domain ?? NO_DOMAIN,
    orgKey,
    existingApp,
    hostnameOwner: domain ? await owner(apps.hostname, names.hostname) : null,
    workerNameOwner: await owner(apps.workerName, names.workerName),
    members: orgMembers,
    deployerUserId: input.deployerUserId,
  });
  const hostname = domain ? plan.app.hostname : (existingApp?.hostname ?? null);
  const app = { ...plan.app, hostname };
  const now = new Date();
  const row = {
    ...app,
    deployedAt: app.deployedAt === null ? null : new Date(app.deployedAt),
    updatedAt: now,
  };
  if (plan.kind === "new") {
    await db.batch([
      db.insert(apps).values({ ...row, createdAt: now }),
      ...plan.grants.map((grant) =>
        db.insert(userAppAccess).values(grant).onConflictDoNothing(),
      ),
    ]);
  } else if (plan.kind === "revived") {
    // The delete took its access, tokens, tools, AI connections and caps
    // (AppRepository.tombstone); it comes back as new.
    await db.batch([
      db
        .update(apps)
        .set({
          name: app.name,
          description: app.description,
          hostname: app.hostname,
          workerName: app.workerName,
          manifest: app.manifest,
          emailSenders: null,
          emailInbound: null,
          secretNames: null,
          status: app.status,
          isDefault: app.isDefault,
          updatedAt: now,
        })
        .where(and(eq(apps.id, app.id), eq(apps.status, "deleted"))),
      ...plan.grants.map((grant) =>
        db.insert(userAppAccess).values(grant).onConflictDoNothing(),
      ),
    ]);
  } else {
    await db
      .update(apps)
      .set({
        name: app.name,
        description: app.description,
        hostname: app.hostname,
        updatedAt: now,
      })
      .where(eq(apps.id, app.id));
  }
  return { ...plan, app };
}

/**
 * The verified upload is live: record its version, the manifest it was
 * built from and who deployed it, over the status it was read with (an
 * admin switching the app off meanwhile keeps it off). A new app moves on
 * to `binding`; the gateway activates it on the first request that reaches
 * its Worker through the dispatch namespace.
 */
export async function recordDispatchDeployed(
  appRowId: string,
  deployed: { versionId: string; manifest: unknown; actor: string },
): Promise<AppRow> {
  try {
    const [stored] = await db.select().from(apps).where(eq(apps.id, appRowId));
    if (!stored) {
      throw new DeployError(
        "APP_NOT_FOUND",
        404,
        "The app's registry row is gone; register it again.",
      );
    }
    const app = toAppRow(stored);
    const update = markDeployedUpdate(app, deployed);
    const changed = await db
      .update(apps)
      .set({
        ...update,
        deployedAt: new Date(update.deployedAt),
        updatedAt: new Date(),
      })
      .where(and(eq(apps.id, appRowId), eq(apps.status, app.status)))
      .returning({ id: apps.id });
    if (changed.length === 0) {
      throw new DeployError(
        "APP_CHANGING",
        409,
        "The app's registry row changed while the deploy recorded its upload. Deploy again.",
      );
    }
    return { ...app, ...update };
  } catch (error) {
    throw asDeployError(error);
  }
}
