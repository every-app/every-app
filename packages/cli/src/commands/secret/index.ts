/**
 * `everyapp secret set|unset|list`: the secrets of the app in this
 * directory, or with `--for gateway`, the Gateway's optional settings.
 *
 * A value comes from a hidden prompt or `--from-env VAR`, never the
 * command line. `set` and `unset` change the live Worker and never deploy:
 * one `cf workers secrets bulk` call per Worker (the app's and each of its
 * helpers', or the Gateway's) makes a new version with the change, under
 * the Worker's lease and after the replace check, and that version is
 * recorded as everyapp's own (the app's Worker record, or the install row's
 * `live_version_id`), so the next `deploy` or `setup` replaces it
 * unattended. The secret is live at once; the code comes from the next
 * deploy, which the output names. `list` prints names, never values.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { LocalContext } from "@/context";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { assertAppSecretName } from "@/lib/app/secrets";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { assertReplaceable, canPromptInTerminal } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets, patchWorkerSecrets } from "@/lib/cf/secrets";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { acquireGatewayLease } from "@/lib/gateway/apply";
import {
  connectToGateway,
  existingGateway,
  requestedGatewayUrl,
} from "@/lib/gateway/connect";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { acquireLease } from "@/lib/gateway/lease";
import { readApp } from "@/lib/gateway/registry";
import { assertSettableSecret } from "@/lib/gateway/secretsFile";
import { deviceLoginAction } from "@/lib/cf/account";
import { EveryAppError } from "@/lib/errors";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { readSecretValue } from "@/lib/secretValue";

interface SecretFlags {
  for?: "gateway";
  gateway?: string;
  "account-id"?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** A Worker whose secrets change, and how its new version is recorded. */
interface SecretTarget {
  workerName: string;
  record: (versionId: string) => Promise<void>;
}

export async function set(
  this: LocalContext,
  flags: SecretFlags & { "from-env"?: string },
  ...names: string[]
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      assertNames(flags, names);
      if (flags["from-env"] && names.length > 1) {
        throw new EveryAppError(
          "SECRET_VALUE_REQUIRED",
          "--from-env reads one value: set one secret at a time with it.",
        );
      }
      const changes: Record<string, string> = {};
      for (const name of names) {
        changes[name] = await readSecretValue(name, {
          fromEnv: flags["from-env"],
          json: flags.json,
        });
      }
      const { versions, next } = await changeSecrets(flags, out, changes);
      const list = names.join(", ");
      out.emit({
        type: "done",
        message: `Set ${list} on ${describe(versions)}: live now, no deploy. ${next}`,
        data: { names, for: flags.for ?? "app", versions, deploy: next },
      });
    },
    { verbose: flags.verbose },
  );
}

export async function unset(
  this: LocalContext,
  flags: SecretFlags,
  ...names: string[]
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      assertNames(flags, names);
      const changes = Object.fromEntries(names.map((name) => [name, null]));
      const { versions, next } = await changeSecrets(flags, out, changes);
      out.emit({
        type: "done",
        message: `Removed ${names.join(", ")} from ${describe(versions)}: live now, no deploy. ${next}`,
        data: { names, for: flags.for ?? "app", versions, deploy: next },
      });
    },
    { verbose: flags.verbose },
  );
}

export async function list(
  this: LocalContext,
  flags: Omit<SecretFlags, "yes">,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const { cf, workerName } =
        flags.for === "gateway"
          ? {
              cf: (
                await existingGateway({
                  json: flags.json,
                  out,
                  accountId: flags["account-id"],
                  installed: true,
                })
              ).cf,
              workerName: GATEWAY_WORKER_NAME,
            }
          : await appWorker(flags, out);
      const names = await listWorkerSecrets(cf, workerName);
      out.emit({
        type: "done",
        message: names.length > 0 ? names.join("\n") : `${workerName} has no secrets.`,
        data: { workerName, names },
      });
    },
    { verbose: flags.verbose },
  );
}

function assertNames(flags: SecretFlags, names: string[]): void {
  if (names.length === 0) {
    throw new EveryAppError("SECRET_NAME_REQUIRED", "Name the secret to change.");
  }
  for (const name of names) {
    if (flags.for === "gateway") assertSettableSecret(name);
    else assertAppSecretName(name);
  }
}

function describe(versions: Record<string, string | null>): string {
  const names = Object.keys(versions);
  return names.length === 1 ? names[0]! : `${names[0]} and its ${names.length - 1 === 1 ? "helper" : `${names.length - 1} helpers`}`;
}

/**
 * Apply the changes to the Gateway, or to the app's Worker and each of its
 * helpers: one new version each, recorded as everyapp's. Returns each
 * Worker's new version and the command that deploys code next.
 */
async function changeSecrets(
  flags: SecretFlags,
  out: EventSink,
  changes: Readonly<Record<string, string | null>>,
): Promise<{ versions: Record<string, string | null>; next: string }> {
  const interactive = canPromptInTerminal(flags.json ?? false);
  if (flags.for === "gateway") {
    const { cf, databaseId } = await existingGateway({
      json: flags.json,
      out,
      accountId: flags["account-id"],
      installed: true,
    });
    const db = cfD1Database(cf, databaseId);
    const lease = await acquireGatewayLease({ db, out }, "gateway.secrets");
    try {
      const install = await readInstall(db);
      if (!install) {
        throw new EveryAppError(
          "GATEWAY_NOT_INSTALLED",
          "No Gateway install record: run `everyapp setup` first.",
        );
      }
      const versions = await applyChanges(
        cf,
        [
          {
            workerName: GATEWAY_WORKER_NAME,
            record: (versionId) =>
              writeInstall(db, { ...install, liveVersionId: versionId, updatedAt: Date.now() }),
          },
        ],
        [install.liveVersionId],
        changes,
        interactive,
        out,
      );
      return { versions, next: "`everyapp setup` deploys this checkout's Gateway code." };
    } finally {
      await lease.release();
    }
  }

  const { cf, registry, workerName, manifestId } = await appRegistry(flags, out);
  const lease = await acquireLease({
    db: registry,
    id: `app:${workerName}`,
    purpose: "app.secrets",
    onWait: (holder) =>
      out.emit({
        type: "progress",
        step: "app.lease",
        message: `Waiting for another deploy of ${manifestId} to finish: ${holder.holder}...`,
      }),
    onHeartbeatProblem: (message) =>
      out.emit({ type: "warning", code: "LEASE_HEARTBEAT", step: "app.lease", message }),
  });
  try {
    const records = (await readOwnedResources(registry, workerName)).filter(
      (resource) => resource.kind === "worker",
    );
    // The app's own Worker first, then each helper deployed with it.
    const targets: SecretTarget[] = [
      {
        workerName,
        record: (versionId) => recordUploadedVersion(registry, workerName, versionId),
      },
      ...records
        .filter((record) => record.binding !== "")
        .map((record) => ({
          workerName: record.name,
          record: (versionId: string) =>
            recordUploadedVersion(registry, workerName, versionId, record.binding),
        })),
    ];
    const recorded = records.map((record) => record.versionId);
    const versions = await applyChanges(cf, targets, recorded, changes, interactive, out);
    return { versions, next: "`everyapp deploy` deploys this directory's code." };
  } finally {
    await lease.release();
  }
}

async function applyChanges(
  cf: CfRunner,
  targets: readonly SecretTarget[],
  recordedVersionIds: ReadonlyArray<string | null | undefined>,
  changes: Readonly<Record<string, string | null>>,
  interactive: boolean,
  out: EventSink,
): Promise<Record<string, string | null>> {
  const versions: Record<string, string | null> = {};
  for (const target of targets) {
    await assertReplaceable({
      cf,
      workerName: target.workerName,
      recordedVersionIds,
      interactive,
      note: "Its secrets change in a new version of what it serves.",
    });
    await patchWorkerSecrets(cf, target.workerName, changes);
    const serving = await getWorkerDeployment(cf, target.workerName);
    const versionId = serving?.versionId ?? null;
    if (versionId) await target.record(versionId);
    versions[target.workerName] = versionId;
    out.emit({
      type: "progress",
      step: "secrets",
      message: `${target.workerName}: version ${versionId ?? "unknown"}.`,
    });
  }
  return versions;
}

/** The deployed Worker of the app in this directory, and cf in its account. */
async function appWorker(flags: SecretFlags, out: EventSink) {
  const { cf, workerName } = await appRegistry(flags, out);
  return { cf, workerName };
}

async function appRegistry(
  flags: SecretFlags,
  out: EventSink,
): Promise<{ cf: CfRunner; registry: D1Database; workerName: string; manifestId: string }> {
  const manifest = await loadEveryAppManifest(process.cwd());
  const { cf, db } = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    onDeviceLogin: flags.json ? deviceLoginAction(out, "app.login") : undefined,
  });
  const { workerName } = await readApp(db, manifest.id);
  return { cf, registry: db, workerName, manifestId: manifest.id };
}
