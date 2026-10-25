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
 * default model provider; with nothing left in it, it is deleted.
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

/**
 * The organization's default model provider as stored (`<provider>` or
 * `<provider>/<model>`), or null when the shipped order decides.
 */
async function getAiDefault(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ aiDefault: orgSettings.aiDefault })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return row?.aiDefault ?? null;
}

/** Set or clear the default model provider; the row goes when nothing is left in it. */
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

/** No default of any kind needs no row. */
async function dropEmptyRow(organizationId: string): Promise<void> {
  const [row] = await db
    .select({
      cap: orgSettings.defaultMonthlyCallCap,
      costCap: orgSettings.defaultMonthlyCostCapMicros,
      aiDefault: orgSettings.aiDefault,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  if (
    row &&
    row.cap === null &&
    row.costCap === null &&
    row.aiDefault === null
  ) {
    await db
      .delete(orgSettings)
      .where(eq(orgSettings.organizationId, organizationId));
  }
}

export const OrgSettingsRepository = {
  getDefaultMonthlyCaps,
  setDefaultMonthlyCaps,
  getAiDefault,
  setAiDefault,
} as const;
