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
import { appSettingsReport, appSetupFor } from "@/server/app-setup";
import { deferEventWork } from "@/server/events/defer";
import { recordSetupState } from "@/server/events/setup-state";

/** The registry columns the evaluation reads, as the lists select them. */
interface ListedAppRow {
  id: string;
  organizationId: string;
  /** The routing slug (`apps.app_slug`), which the setup command names. */
  appId: string;
  name: string;
  tier: string;
  versionId: string | null;
  manifest: string | null;
  secretNames: string | null;
}

/**
 * `canFix`: whoever reads the list can run the command (the app is their
 * organization's); a shared app seen from another organization lists its
 * unmet settings without one. The result is also recorded on the row
 * after the response (`apps.setup_state`, server/events/setup-state.ts),
 * which announces an app that came to need setup, or became ready.
 */
export async function listedAppSetup(
  row: ListedAppRow,
  canFix: boolean,
): Promise<AppSetup | null> {
  try {
    const input = {
      rowId: row.id,
      versionId: row.versionId,
      secretNames: parseSecretNames(row.secretNames),
      appId: row.appId,
      tier: row.tier,
      manifest: row.manifest,
      canFix,
    };
    const report = await appSettingsReport(input);
    if (report) {
      deferEventWork(() =>
        recordSetupState({
          rowId: row.id,
          organizationId: row.organizationId,
          appId: row.appId,
          name: row.name,
          ready: report.ready,
          unmet: report.unmet.flatMap((setting) => setting.names),
        }),
      );
    }
    return await appSetupFor(input);
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
