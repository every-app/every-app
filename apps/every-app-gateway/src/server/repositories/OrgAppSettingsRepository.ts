import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, orgAppSettings, orgSettings } from "@/db/schema";
import { effectiveMonthlyCaps, type EffectiveCaps } from "@/server/app-cap";

/** The organization's own row on an app as stored, or the empty row when there is none. */
interface AppCapRow {
  monthlyCallCap: number | null;
  /** Micro-dollars. */
  monthlyCostCapMicros: number | null;
  unlimited: boolean;
}

/**
 * The caps that bind an app's provider calls for the organization this
 * month, each kind on its own: the app's own cap, none when the app is
 * unlimited, else the organization's default (`org_settings`), else none.
 * One query: the organization, with its row on the app and its defaults
 * joined.
 */
async function getEffectiveMonthlyCaps(
  organizationId: string,
  appRowId: string,
): Promise<EffectiveCaps> {
  const [row] = await db
    .select({
      appCap: orgAppSettings.monthlyCallCap,
      appCostCap: orgAppSettings.monthlyCostCapMicros,
      unlimited: orgAppSettings.unlimited,
      defaultCap: orgSettings.defaultMonthlyCallCap,
      defaultCostCap: orgSettings.defaultMonthlyCostCapMicros,
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
  return effectiveMonthlyCaps({
    appCap: row?.appCap ?? null,
    appCostCap: row?.appCostCap ?? null,
    unlimited: row?.unlimited ?? false,
    defaultCap: row?.defaultCap ?? null,
    defaultCostCap: row?.defaultCostCap ?? null,
  });
}

/** The organization's own row on the app, before a write that keeps what it doesn't name. */
async function getAppCapRow(
  organizationId: string,
  appRowId: string,
): Promise<AppCapRow> {
  const [row] = await db
    .select({
      monthlyCallCap: orgAppSettings.monthlyCallCap,
      monthlyCostCapMicros: orgAppSettings.monthlyCostCapMicros,
      unlimited: orgAppSettings.unlimited,
    })
    .from(orgAppSettings)
    .where(
      and(
        eq(orgAppSettings.organizationId, organizationId),
        eq(orgAppSettings.appRowId, appRowId),
      ),
    )
    .limit(1);
  return (
    row ?? {
      monthlyCallCap: null,
      monthlyCostCapMicros: null,
      unlimited: false,
    }
  );
}

/**
 * Set the organization's caps on the app (`cap`, `costCapMicros`), say
 * the app has none whatever the defaults (`unlimited`), or neither: delete
 * the row, so the defaults apply, and without them the app is unlimited.
 * Every column is written in one statement, keeping the row invariant.
 */
async function setMonthlyCap(input: {
  organizationId: string;
  appRowId: string;
  cap: number | null;
  costCapMicros: number | null;
  unlimited: boolean;
  updatedBy: string;
}): Promise<void> {
  const { organizationId, appRowId, cap, costCapMicros, unlimited, updatedBy } =
    input;
  if (cap === null && costCapMicros === null && !unlimited) {
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
    monthlyCallCap: cap,
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
  getEffectiveMonthlyCaps,
  getAppCapRow,
  setMonthlyCap,
} as const;
