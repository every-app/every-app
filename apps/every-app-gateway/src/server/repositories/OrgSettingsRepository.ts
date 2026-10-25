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
 * Set or clear the default. Clearing deletes the row: no default needs
 * none, and the table holds nothing else yet.
 */
async function setDefaultMonthlyCap(input: {
  organizationId: string;
  cap: number | null;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, cap, updatedBy } = input;
  if (cap === null) {
    await db
      .delete(orgSettings)
      .where(eq(orgSettings.organizationId, organizationId));
    return;
  }
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
}

export const OrgSettingsRepository = {
  getDefaultMonthlyCap,
  setDefaultMonthlyCap,
} as const;
