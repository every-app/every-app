import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, orgAppSettings, orgSettings } from "@/db/schema";
import { effectiveMonthlyCap, type EffectiveCap } from "@/server/app-cap";

/**
 * The cap that binds an app's provider calls for the organization this
 * month: the app's own cap, none when the app is unlimited, else the
 * organization's default (`org_settings`), else none. One query: the
 * organization, with its row on the app and its defaults joined.
 */
async function getEffectiveMonthlyCap(
  organizationId: string,
  appRowId: string,
): Promise<EffectiveCap> {
  const [row] = await db
    .select({
      appCap: orgAppSettings.monthlyCallCap,
      unlimited: orgAppSettings.unlimited,
      defaultCap: orgSettings.defaultMonthlyCallCap,
    })
    .from(organizations)
    .leftJoin(
      orgAppSettings,
      and(
        eq(orgAppSettings.organizationId, organizations.id),
        eq(orgAppSettings.appRowId, appRowId),
      ),
    )
    .leftJoin(orgSettings, eq(orgSettings.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!row) return { cap: null, source: null };
  return effectiveMonthlyCap({
    appCap: row.appCap,
    unlimited: row.unlimited ?? false,
    defaultCap: row.defaultCap,
  });
}

/**
 * Set the organization's cap on the app (`cap`), say the app has none
 * whatever the default (`unlimited`), or neither: delete the row, so the
 * default applies, and without one the app is unlimited. Both columns are
 * written in one statement, keeping the row invariant.
 */
async function setMonthlyCap(input: {
  organizationId: string;
  appRowId: string;
  cap: number | null;
  unlimited: boolean;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, appRowId, cap, unlimited, updatedBy } = input;
  if (cap === null && !unlimited) {
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
  const row = { monthlyCallCap: cap, unlimited, updatedAt, updatedBy };
  await db
    .insert(orgAppSettings)
    .values({ organizationId, appRowId, ...row })
    .onConflictDoUpdate({
      target: [orgAppSettings.organizationId, orgAppSettings.appRowId],
      set: row,
    });
}

export const OrgAppSettingsRepository = {
  getEffectiveMonthlyCap,
  setMonthlyCap,
} as const;
