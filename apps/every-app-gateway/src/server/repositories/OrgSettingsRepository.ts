import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgSettings } from "@/db/schema";

/** The organization's default monthly cap on every app's provider calls, or null. */
async function getDefaultMonthlyCap(
  organizationId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ cap: orgSettings.defaultMonthlyCallCap })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  return row?.cap ?? null;
}

/**
 * Set or clear the default cap. The row stays when it still holds the
 * default model provider; with nothing left in it, it is deleted.
 */
async function setDefaultMonthlyCap(input: {
  organizationId: string;
  cap: number | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, cap, updatedBy } = input;
  const updatedAt = new Date();
  await db
    .insert(orgSettings)
    .values({
      organizationId,
      defaultMonthlyCallCap: cap,
      updatedAt,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: orgSettings.organizationId,
      set: { defaultMonthlyCallCap: cap, updatedAt, updatedBy },
    });
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

/** No default of either kind needs no row. */
async function dropEmptyRow(organizationId: string): Promise<void> {
  const [row] = await db
    .select({
      cap: orgSettings.defaultMonthlyCallCap,
      aiDefault: orgSettings.aiDefault,
    })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  if (row && row.cap === null && row.aiDefault === null) {
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
} as const;
