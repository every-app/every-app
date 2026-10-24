/**
 * An app's setup as the app lists carry it (`setup` on `getMyApps`,
 * `/api/me/apps` and Admin → Apps): the row's manifest against the
 * Gateway's env and the secret names the CLI recorded, through
 * server/app-setup.ts. One app's evaluation failing (a manifest the model
 * can't read, the email rule throwing) must not take the whole list down,
 * so it is logged and the app lists with `setup: null`, as if it had
 * nothing to set.
 */
import { logEvent } from "@every-app/perimeter";
import { parseSecretNames } from "@every-app/perimeter/registry";
import type { AppSetup } from "@every-app/sdk/internal";
import { appSetupFor } from "@/server/app-setup";

/** The registry columns the evaluation reads, as the lists select them. */
interface ListedAppRow {
  id: string;
  /** The routing slug (`apps.app_slug`), which the setup command names. */
  appId: string;
  tier: string;
  versionId: string | null;
  manifest: string | null;
  secretNames: string | null;
}

/**
 * `canFix`: whoever reads the list can run the command (the app is their
 * organization's); a shared app seen from another organization lists its
 * unmet settings without one.
 */
export async function listedAppSetup(
  row: ListedAppRow,
  canFix: boolean,
): Promise<AppSetup | null> {
  try {
    return await appSetupFor({
      rowId: row.id,
      versionId: row.versionId,
      secretNames: parseSecretNames(row.secretNames),
      appId: row.appId,
      tier: row.tier,
      manifest: row.manifest,
      canFix,
    });
  } catch (error) {
    logEvent(
      "app.setup_unavailable",
      {
        appId: row.appId,
        rowId: row.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return null;
  }
}
