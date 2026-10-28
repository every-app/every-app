import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgSettings } from "@/db/schema";

/** The organization's default monthly caps on every app: calls, and micro-dollars of reported cost. */
interface DefaultCaps {
  cap: number | null;
  costCapMicros: number | null;
}

/** The organization's default monthly caps on every app's provider calls, null for none. */
async function getDefaultMonthlyCaps(
  organizationId: string,
): Promise<DefaultCaps> {
  const [row] = await db
    .select({
      cap: orgSettings.defaultMonthlyCallCap,
      costCapMicros: orgSettings.defaultMonthlyCostCapMicros,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return { cap: row?.cap ?? null, costCapMicros: row?.costCapMicros ?? null };
}

/**
 * Set or clear both default caps. The row stays when it still holds the
 * default model provider or models; with nothing left in it, it is deleted.
 */
async function setDefaultMonthlyCaps(input: {
  organizationId: string;
  cap: number | null;
  costCapMicros: number | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, cap, costCapMicros, updatedBy } = input;
  const updatedAt = new Date();
  const set = {
    defaultMonthlyCallCap: cap,
    defaultMonthlyCostCapMicros: costCapMicros,
    updatedAt,
    updatedBy,
  };
  await db
    .insert(orgSettings)
    .values({ organizationId, ...set })
    .onConflictDoUpdate({ target: orgSettings.organizationId, set });
  await dropEmptyRow(organizationId);
}

/** The organization's AI settings as stored: the default provider's id and the model settings (JSON), each null when unset. */
export interface StoredAiSettings {
  aiDefault: string | null;
  aiModels: string | null;
}

/** The organization's default model provider and models as stored, null where the shipped order and the seeds decide. */
async function getAiSettings(
  organizationId: string,
): Promise<StoredAiSettings> {
  const [row] = await db
    .select({
      aiDefault: orgSettings.aiDefault,
      aiModels: orgSettings.aiModels,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return { aiDefault: row?.aiDefault ?? null, aiModels: row?.aiModels ?? null };
}

/**
 * Write the default model provider and the model settings together (a
 * choice with a model writes both); the row goes when nothing is left in
 * it.
 */
async function setAiSettings(
  input: StoredAiSettings & { organizationId: string; updatedBy: string },
): Promise<void> {
  const { organizationId, aiDefault, aiModels, updatedBy } = input;
  const updatedAt = new Date();
  await db
    .insert(orgSettings)
    .values({ organizationId, aiDefault, aiModels, updatedAt, updatedBy })
    .onConflictDoUpdate({
      target: orgSettings.organizationId,
      set: { aiDefault, aiModels, updatedAt, updatedBy },
    });
  await dropEmptyRow(organizationId);
}

/**
 * Whether linked dev is on for the organization (docs/design/linked-dev.md):
 * owners and admins may sign `everyapp dev --gateway` in to its apps. Off
 * without a row.
 */
async function isLinkedDevOn(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ linkedDev: orgSettings.linkedDev })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return row?.linkedDev ?? false;
}

/** Turn linked dev on or off; the row goes when nothing else is left in it. */
async function setLinkedDev(input: {
  organizationId: string;
  on: boolean;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, on, updatedBy } = input;
  const updatedAt = new Date();
  await db
    .insert(orgSettings)
    .values({ organizationId, linkedDev: on, updatedAt, updatedBy })
    .onConflictDoUpdate({
      target: orgSettings.organizationId,
      set: { linkedDev: on, updatedAt, updatedBy },
    });
  await dropEmptyRow(organizationId);
}

/** No default of any kind needs no row. */
async function dropEmptyRow(organizationId: string): Promise<void> {
  const [row] = await db
    .select({
      cap: orgSettings.defaultMonthlyCallCap,
      costCap: orgSettings.defaultMonthlyCostCapMicros,
      aiDefault: orgSettings.aiDefault,
      aiModels: orgSettings.aiModels,
      linkedDev: orgSettings.linkedDev,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  if (
    row &&
    row.cap === null &&
    row.costCap === null &&
    row.aiDefault === null &&
    row.aiModels === null &&
    !row.linkedDev
  ) {
    await db
      .delete(orgSettings)
      .where(eq(orgSettings.organizationId, organizationId));
  }
}

export const OrgSettingsRepository = {
  getDefaultMonthlyCaps,
  setDefaultMonthlyCaps,
  getAiSettings,
  setAiSettings,
  isLinkedDevOn,
  setLinkedDev,
} as const;
