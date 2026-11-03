import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, orgAppSettings, orgSettings } from "@/db/schema";
import { effectiveMonthlyCap, type EffectiveCap } from "@/server/app-cap";

/**
 * The cap that binds an app's provider calls for the organization this
 * month: the app's own cap, none when the app is unlimited, else the
 * organization's default (`org_settings`), else none. One query: the
 * organization, with its row on the app and its default joined.
 */
async function getEffectiveMonthlyCap(
  organizationId: string,
  appRowId: string,
): Promise<EffectiveCap> {
  const [row] = await db
    .select({
      appCap: orgAppSettings.monthlyCostCapMicros,
      unlimited: orgAppSettings.unlimited,
      defaultCap: orgSettings.defaultMonthlyCostCapMicros,
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
  return effectiveMonthlyCap({
    appCap: row?.appCap ?? null,
    unlimited: row?.unlimited ?? false,
    defaultCap: row?.defaultCap ?? null,
  });
}

/**
 * Set the organization's cap on the app (`costCapMicros`), say the app has
 * none whatever the default (`unlimited`), or neither: delete the row, so
 * the default applies, and without one the app is unlimited. Every column
 * is written in one statement, keeping the row invariant.
 */
async function setMonthlyCap(input: {
  organizationId: string;
  appRowId: string;
  costCapMicros: number | null;
  unlimited: boolean;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, appRowId, costCapMicros, unlimited, updatedBy } =
    input;
  if (costCapMicros === null && !unlimited) {
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
  const row = {
    monthlyCostCapMicros: costCapMicros,
    unlimited,
    updatedAt,
    updatedBy,
  };
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
