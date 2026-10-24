import { restoreD1 } from "@/lib/cf/d1";
import { canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { acquireLease, LeasePurpose } from "@/lib/gateway/lease";
import { readApp } from "@/lib/gateway/registry";
import {
  appRestoreTarget,
  forgetRestorePoint,
  GATEWAY_RESTORE_TARGET,
  readRestorePoint,
  type RestorePoint,
} from "@/lib/gateway/restorePoints";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { plural } from "@/lib/output/text";
import { roughly } from "@/lib/output/time";
import { eventSink, runReported } from "@/lib/output/run";

interface RestoreCommandFlags {
  gateway?: boolean;
  "account-id"?: string;
  yes?: boolean;
  json?: boolean;
}

/**
 * `everyapp db restore [app]`: put the app's database (the one in this
 * directory, or the one named) back to the restore point its last
 * migrating deploy saved; `--gateway`, the Gateway's, from its last
 * migrating setup or upgrade.
 */
export async function restore(flags: RestoreCommandFlags,
  appId?: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    await restoreDatabase({
      cwd: process.cwd(),
      appId,
      gateway: flags.gateway ?? false,
      accountId: flags["account-id"],
      yes: flags.yes ?? false,
      json: flags.json ?? false,
      out,
    });
  });
}

interface RestoreDatabaseOptions {
  cwd: string;
  /** The app named on the command line; else the one in `cwd`. */
  appId?: string;
  /** The Gateway's database instead of an app's. */
  gateway: boolean;
  accountId?: string;
  /** Restore without asking. */
  yes: boolean;
  json: boolean;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** A person at a terminal answers (default: one is there, without --json). */
  interactive?: boolean;
  confirm?: Confirm;
}

export async function restoreDatabase({
  cwd,
  appId: named,
  gateway,
  accountId,
  yes,
  json,
  out,
  createCf,
  interactive = canPromptInTerminal(json),
  confirm,
}: RestoreDatabaseOptions): Promise<void> {
  if (gateway && named) {
    throw new EveryAppError("RESTORE_TARGET_TWICE", `Pass ${named} or --gateway, not both`, {
      data: { fix: "drop one of them" },
    });
  }
  const appId = gateway ? null : (named ?? (await loadEveryAppManifest(cwd)).id);
  const { cf, db } = await connectToGateway({
    gateway: requestedGatewayUrl(),
    accountId,
    interactive,
    login: { json, out, step: "db.login" },
    createCf,
  });
  const target = appId
    ? appRestoreTarget((await readApp(db, appId)).workerName)
    : GATEWAY_RESTORE_TARGET;
  const whose = appId ? `${appId}'s database` : "the Gateway's database";

  const point = await readRestorePoint(db, target);
  if (!point) {
    throw new EveryAppError(
      "NO_RESTORE_POINT",
      `No restore point for ${whose}\neveryapp saves one when ${appId ? "a deploy" : "setup or a Gateway upgrade"} migrates a database that has data.`,
    );
  }
  const data = {
    appId,
    databaseId: point.databaseId,
    bookmark: point.bookmark,
    migrations: point.migrations,
    createdAt: point.createdAt,
    createdBy: point.createdBy,
  };

  await confirmUnlessYes({
    yes,
    interactive,
    confirm,
    question: `Put ${whose} back to before ${undoes(point)}?`,
    unattended: `Restoring ${whose} needs a person at a terminal to confirm, or --yes\nIt undoes ${undoes(point)}; anything written to it since is lost too.`,
    context: ["Anything written to the database since then is lost too."],
    data,
  });

  // Never in the middle of a deploy's migration or upload.
  const lease = await acquireLease({
    db,
    id: target,
    purpose: LeasePurpose.DbRestore,
    ...(appId ? { app: appId } : {}),
    out,
    step: "db.lease",
  });
  try {
    await lease.check();
    out.emit({ type: "step", step: "db.restore", status: "start", data });
    await restoreD1(cf, point.databaseId, point.bookmark);
    // The Gateway's own row went with the restore; an app's is used up.
    await forgetRestorePoint(db, target);
    out.emit({
      type: "step",
      step: "db.restore",
      status: "ok",
      message: `Restored ${whose} to before ${point.migrations.join(", ")}.`,
      data,
    });
  } finally {
    await lease.release();
  }
  out.emit({ type: "done", data });
}

/** "2 migrations (0001_x.sql, 0002_y.sql) applied 3m ago by ben@example.com" */
function undoes(point: RestorePoint, now = Date.now()): string {
  const by = point.createdBy.startsWith("api-token:") ? "an API token" : point.createdBy;
  return `${plural(point.migrations.length, "migration")} (${point.migrations.join(", ")}) applied ${roughly(now - point.createdAt)} ago by ${by}`;
}
