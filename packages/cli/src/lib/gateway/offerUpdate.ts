/**
 * A command stopped because the Gateway's database is behind this everyapp
 * (GATEWAY_OUTDATED, ./schema.ts). The fix is one command, `everyapp
 * update`, so a person at a terminal is asked whether to run it now, and
 * on Yes the update runs and their command starts again.
 *
 * Only a person is asked. Under --json, with no terminal, in CI, and with
 * --yes, nothing is offered and the error stands: an update migrates the
 * Gateway's database and replaces its code for everyone, which a script
 * that deploys an app never asked for ("deploying an app never changes the
 * Gateway").
 *
 * The update is `everyapp update --gateway <url> --account-id <id>` as
 * typed: the same guards, the same restore point, the same lines. When it
 * fails, its own error is the run's (what failed, and how to put the
 * database back if it had been migrated); the command the person typed
 * hasn't started.
 */
import { EveryAppError } from "@/lib/errors";
import { asCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmYesAtTerminal, type Confirm } from "@/lib/output/prompt";

interface OutdatedGateway {
  gatewayUrl: string;
  accountId: string;
}

/** The Gateway a GATEWAY_OUTDATED error is about, when it says which. */
function outdatedGateway(error: unknown): OutdatedGateway | null {
  if (!(error instanceof EveryAppError) || error.code !== "GATEWAY_OUTDATED") return null;
  const { gatewayUrl, accountId } = error.data ?? {};
  return typeof gatewayUrl === "string" && typeof accountId === "string" ? { gatewayUrl, accountId } : null;
}

export interface OfferUpdateSeams {
  canPrompt?: (json: boolean) => boolean;
  confirm?: Confirm;
  /** `everyapp update` on that Gateway, reporting to `out`. */
  update?: (gateway: OutdatedGateway, out: EventSink, verbose: boolean) => Promise<void>;
}

/**
 * Whether `error` was an outdated Gateway that is now updated, so the
 * command can start again. False when it is another error, when nobody can
 * be asked, or when the person said No. Throws what the update throws.
 */
export async function offerGatewayUpdate(
  error: unknown,
  flags: { json?: boolean; verbose?: boolean; yes?: boolean },
  out: EventSink,
  { canPrompt = canPromptInTerminal, confirm = confirmYesAtTerminal, update = runUpdate }: OfferUpdateSeams = {},
): Promise<boolean> {
  const gateway = outdatedGateway(error);
  if (!gateway || flags.yes || !canPrompt(flags.json ?? false)) return false;
  const host = new URL(gateway.gatewayUrl).host;
  const yes = await confirm("Update it now?", [
    `The Gateway at ${host} is older than this everyapp.`,
    "Updating migrates its database (with a restore point) and deploys this everyapp's Gateway.",
  ]);
  if (!yes) return false;
  await update(gateway, out, flags.verbose ?? false);
  return true;
}

/** `everyapp update --gateway <url> --account-id <id>`, as the command runs it. */
async function runUpdate({ gatewayUrl, accountId }: OutdatedGateway, out: EventSink, verbose: boolean): Promise<void> {
  // Loaded here: the commands import the runner this is called from.
  const [{ runGatewayDeploy, setupDeps }, { gatewayReleaseSource }, { cliVersion }] = await Promise.all([
    import("@/commands/setup/runSetup"),
    import("./source"),
    import("@/lib/version"),
  ]);
  const release = gatewayReleaseSource({ out, verbose, cliVersion });
  await asCommand(["update", "--gateway", gatewayUrl, "--account-id", accountId], () =>
    runGatewayDeploy(
      { gateway: gatewayUrl, "account-id": accountId, verbose },
      out,
      setupDeps({ gateway: { openRelease: release.open, source: release.describe }, interactive: true }),
    ),
  );
}
