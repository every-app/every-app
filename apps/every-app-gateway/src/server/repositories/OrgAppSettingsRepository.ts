import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgAppSettings } from "@/db/schema";

/**
 * The organization's monthly cap on an app's provider calls, or null when
 * none is set (no row, or a row with none).
 */
async function getMonthlyCap(
  organizationId: string,
  appRowId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ cap: orgAppSettings.monthlyCallCap })
    .from(orgAppSettings)
    .where(
      and(
        eq(orgAppSettings.organizationId, organizationId),
        eq(orgAppSettings.appRowId, appRowId),
      ),
    )
    .limit(1);
  return row?.cap ?? null;
}

/**
 * Set or clear the cap. Clearing deletes the row: the default needs none,
 * and the table holds nothing else yet.
 */
async function setMonthlyCap(input: {
  organizationId: string;
  appRowId: string;
  cap: number | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, appRowId, cap, updatedBy } = input;
  if (cap === null) {
    await db
      .delete(orgAppSettings)
      .where(
        and(
          eq(orgAppSettings.organizationId, organizationId),
          eq(orgAppSettings.appRowId, appRowId),
        ),
      );
    return;
  }
  const updatedAt = new Date();
  await db
    .insert(orgAppSettings)
    .values({
      organizationId,
      appRowId,
      monthlyCallCap: cap,
      updatedAt,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: [orgAppSettings.organizationId, orgAppSettings.appRowId],
      set: { monthlyCallCap: cap, updatedAt, updatedBy },
    });
}

export const OrgAppSettingsRepository = {
  getMonthlyCap,
  setMonthlyCap,
} as const;
