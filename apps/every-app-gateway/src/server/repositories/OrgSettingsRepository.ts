import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgSettings } from "@/db/schema";

/**
 * The organization's default monthly cap on every app's provider calls, in
 * micro-dollars of reported cost; null for none.
 */
async function getDefaultMonthlyCap(
  organizationId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ costCapMicros: orgSettings.defaultMonthlyCostCapMicros })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return row?.costCapMicros ?? null;
}

/**
 * Set or clear the default cap. The row stays when it still holds the
 * default model or linked dev; with nothing left in it,
 * it is deleted.
 */
async function setDefaultMonthlyCap(input: {
  organizationId: string;
  costCapMicros: number | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, costCapMicros, updatedBy } = input;
  const updatedAt = new Date();
  const set = {
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

/** The workspace's default model as stored (`<provider>[/<model>]`), or null when the shipped order decides. */
async function getAiDefault(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ aiDefault: orgSettings.aiDefault })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return row?.aiDefault ?? null;
}

/** Write the workspace's default model, or clear it (null); the row goes when nothing is left in it. */
async function setAiDefault(input: {
  organizationId: string;
  aiDefault: string | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, aiDefault, updatedBy } = input;
  const updatedAt = new Date();
  await db
    .insert(orgSettings)
    .values({ organizationId, aiDefault, updatedAt, updatedBy })
    .onConflictDoUpdate({
      target: orgSettings.organizationId,
      set: { aiDefault, updatedAt, updatedBy },
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
      costCap: orgSettings.defaultMonthlyCostCapMicros,
      aiDefault: orgSettings.aiDefault,
      linkedDev: orgSettings.linkedDev,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  if (row && row.costCap === null && row.aiDefault === null && !row.linkedDev) {
    await db
      .delete(orgSettings)
      .where(eq(orgSettings.organizationId, organizationId));
  }
}

export const OrgSettingsRepository = {
  getDefaultMonthlyCap,
  setDefaultMonthlyCap,
  getAiDefault,
  setAiDefault,
  isLinkedDevOn,
  setLinkedDev,
} as const;
