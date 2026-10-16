/**
 * The app registry written the way the CLI writes it over D1 in self-host
 * (ADR-0003): read the rows the perimeter's registration rules need, run
 * them, and write what they return in one batch. Tests use it to put apps
 * into a test database without a deploy API.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  appNames,
  markDeployedUpdate,
  orgKeyCandidates,
  planRegistration,
  type AppRow,
  type RegistrationPlan,
} from "@every-app/perimeter/registry";
import * as schema from "@/db/schema";
import type { TestDb } from "./sqlite-db";

const { apps, members, organizationKeys, organizations, userAppAccess } =
  schema;

type StoredApp = typeof apps.$inferSelect;

function toAppRow(row: StoredApp): AppRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    appSlug: row.appSlug,
    name: row.name,
    description: row.description,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier,
    manifest: row.manifest,
    status: row.status,
    versionId: row.versionId,
    deployedAt: row.deployedAt?.getTime() ?? null,
    deployedByActor: row.deployedByActor,
    isDefault: row.isDefault,
  };
}

function fromAppRow(app: AppRow) {
  return {
    ...app,
    deployedAt: app.deployedAt === null ? null : new Date(app.deployedAt),
  };
}

async function claimOrgKey(db: TestDb, organizationId: string, slug: string) {
  const key = async () =>
    (
      await db
        .select({ orgKey: organizationKeys.orgKey })
        .from(organizationKeys)
        .where(eq(organizationKeys.organizationId, organizationId))
    )[0]?.orgKey;
  const existing = await key();
  if (existing) return existing;
  for (const candidate of orgKeyCandidates(slug)) {
    await db
      .insert(organizationKeys)
      .values({ organizationId, orgKey: candidate })
      .onConflictDoNothing();
    const claimed = await key();
    if (claimed) return claimed;
  }
  throw new Error(`no org key for ${slug}`);
}

/**
 * The install's own organization: the oldest with an owner, or before the
 * gateway has one, the oldest of all.
 */
async function installOrganizationId(db: TestDb): Promise<string | null> {
  const [owned] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.role, "owner"),
      ),
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);
  if (owned) return owned.id;
  const [oldest] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);
  return oldest?.id ?? null;
}

export async function registerApp(
  db: TestDb,
  input: {
    organizationId: string;
    appSlug: string;
    manifest?: unknown;
    name?: string;
    description?: string;
    deployerUserId?: string | null;
    appBaseDomain?: string;
    isInstallOrganization?: boolean;
  },
): Promise<RegistrationPlan> {
  const { organizationId, appSlug } = input;
  const [organization] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization) throw new Error(`no organization ${organizationId}`);
  const orgKey = await claimOrgKey(db, organizationId, organization.slug);
  const isInstallOrganization =
    input.isInstallOrganization ??
    (await installOrganizationId(db)) === organizationId;
  const appBaseDomain = input.appBaseDomain ?? "apps.example.com";

  const [existing] = await db
    .select()
    .from(apps)
    .where(
      and(eq(apps.organizationId, organizationId), eq(apps.appSlug, appSlug)),
    );
  const existingApp = existing ? toAppRow(existing) : null;
  const names = appNames({
    appSlug,
    orgKey,
    isInstallOrganization,
    appBaseDomain,
    existingApp,
  });
  const [hostnameOwner] = await db
    .select()
    .from(apps)
    .where(eq(apps.hostname, names.hostname));
  const [workerNameOwner] = await db
    .select()
    .from(apps)
    .where(eq(apps.workerName, names.workerName));
  const orgMembers = await db
    .select({ id: members.userId, role: members.role })
    .from(members)
    .where(eq(members.organizationId, organizationId));

  const plan = planRegistration({
    organizationId,
    isInstallOrganization,
    appSlug,
    name: input.name ?? appSlug,
    description: input.description ?? appSlug,
    manifest: input.manifest ?? { id: appSlug },
    appBaseDomain,
    orgKey,
    existingApp,
    hostnameOwner: hostnameOwner ? toAppRow(hostnameOwner) : null,
    workerNameOwner: workerNameOwner ? toAppRow(workerNameOwner) : null,
    members: orgMembers,
    deployerUserId: input.deployerUserId ?? null,
  });

  const row = fromAppRow(plan.app);
  await db.batch([
    db
      .insert(apps)
      .values(row)
      .onConflictDoUpdate({ target: apps.id, set: row }),
    ...plan.grants.map((grant) =>
      db.insert(userAppAccess).values(grant).onConflictDoNothing(),
    ),
  ]);
  return plan;
}

/** Record an uploaded version, as the CLI does after `cf deploy`. */
export async function markAppDeployed(
  db: TestDb,
  appRowId: string,
  deployed: { versionId: string; manifest: unknown; actor?: string },
): Promise<void> {
  const [row] = await db.select().from(apps).where(eq(apps.id, appRowId));
  if (!row) throw new Error(`no app ${appRowId}`);
  const update = markDeployedUpdate(toAppRow(row), {
    actor: "deployer@example.com",
    ...deployed,
  });
  await db
    .update(apps)
    .set({ ...update, deployedAt: new Date(update.deployedAt) })
    .where(eq(apps.id, appRowId));
}

/**
 * Register, upload and activate an app (activation is the gateway's own
 * first request over the new binding); returns its row id.
 */
export async function deployLiveApp(
  db: TestDb,
  input: Parameters<typeof registerApp>[1] & { versionId?: string },
): Promise<RegistrationPlan> {
  const plan = await registerApp(db, input);
  await markAppDeployed(db, plan.app.id, {
    versionId: input.versionId ?? `${input.appSlug}-version`,
    manifest: input.manifest ?? { id: input.appSlug },
  });
  await db
    .update(apps)
    .set({ status: "active" })
    .where(eq(apps.id, plan.app.id));
  return plan;
}
