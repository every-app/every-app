/**
 * `everyapp teardown --account-id <id>`: the clean slate the onboarding
 * loop needs between runs. Guards first (lib/teardown/guards.ts: a
 * forbidden id, the allowlist, a token, what the token sees), then the
 * inventory, read-only (lib/teardown/inventory.ts), shown and, unless
 * `--dry-run`, confirmed by the account id typed at the terminal or passed
 * as `--confirm`; then the deletions, kind by kind (lib/teardown/delete.ts).
 */
import chalk from "chalk";
import { cfWhoami } from "@/lib/cf/account";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { CancelledError, EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { askText, canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { listed, plural } from "@/lib/output/text";
import { executeTeardown } from "@/lib/teardown/delete";
import { checkAccountEligible, checkTokenScope, TeardownCode } from "@/lib/teardown/guards";
import { inventoryAccount } from "@/lib/teardown/inventory";
import { planData, planLines, planSummary, planTotal, type TeardownPlan } from "@/lib/teardown/plan";

interface TeardownFlags {
  "account-id": string;
  confirm?: string;
  "dry-run"?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** What the handler takes from the command line, and the seams tests use. */
interface TeardownOptions {
  flags: TeardownFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** Whether a person is at the terminal (default: canPromptInTerminal); tests. */
  interactive?: boolean;
  /** Asks the person at the terminal to type the account id (tests answer for them). */
  askConfirmation?: (accountId: string, planShown: readonly string[]) => Promise<string>;
  /** The environment the guards read (default: the process's); tests. */
  env?: NodeJS.ProcessEnv;
  /** Waits before the second look at a refused certificate pack (tests answer at once). */
  sleep?: (ms: number) => Promise<void>;
}

const CHECK = "teardown.check";

export async function teardown(flags: TeardownFlags): Promise<void> {
  await runCommand(flags, (out) => teardownAccount({ flags, out }));
}

export async function teardownAccount(options: TeardownOptions): Promise<void> {
  const { flags, out } = options;
  const env = options.env ?? process.env;
  const createCf = options.createCf ?? ((accountId?: string) => createCfRunner({ accountId, env }));
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const dryRun = flags["dry-run"] ?? false;

  // 1–3. Before anything of Cloudflare is read.
  out.emit({ type: "step", step: CHECK, status: "start", message: "Checking the account may be torn down..." });
  const { accountId, allowlist, forbidden } = checkAccountEligible({ accountId: flags["account-id"], out, env });
  // A confirmation that can't match is refused before any read too.
  const confirm = flags.confirm?.trim().toLowerCase();
  if (confirm !== undefined && confirm !== accountId) {
    throw new EveryAppError(
      TeardownCode.ConfirmMismatch,
      `--confirm ${flags.confirm} isn't the account id\nIt must repeat --account-id ${accountId} exactly. Nothing was read or changed.`,
      { fix: `pass --confirm ${accountId}`, data: { accountId, confirm: flags.confirm } },
    );
  }
  // 4. What the token sees: the one read before the inventory.
  checkTokenScope({ accountId, allowlist, forbidden, whoami: await cfWhoami(createCf()) });
  out.emit({
    type: "step",
    step: CHECK,
    status: "ok",
    message: `${accountId} is a test account, and the token sees it alone`,
    data: { accountId },
  });

  // 5. The inventory, read-only.
  const cf = createCf(accountId);
  const plan = await inventoryAccount({ cf, accountId, out });
  const total = planTotal(plan);
  const shown = planLines(plan);

  if (dryRun) {
    const message =
      total === 0
        ? `Nothing of EveryApp is left in ${accountId}.`
        : `Dry run: ${planSummary(plan)} would be removed from ${accountId}. Nothing was changed.`;
    out.emit({
      type: "done",
      message,
      display: [
        chalk.bold(total === 0 ? message : `Would remove ${planSummary(plan)} from ${accountId}`),
        ...(total === 0 ? shown.slice(1) : shown),
        ...(total === 0 ? [] : ["", chalk.dim("Nothing was changed (--dry-run).")]),
      ].join("\n"),
      data: { accountId, dryRun: true, removed: [], kept: [], plan: planData(plan) },
    });
    return;
  }
  if (total === 0) {
    const message = `Nothing of EveryApp is left in ${accountId}.`;
    out.emit({
      type: "done",
      message,
      display: [chalk.green(message), ...shown.slice(1)].join("\n"),
      data: { accountId, dryRun: false, removed: [], kept: [], plan: planData(plan) },
    });
    return;
  }

  // 6. The confirmation: the id typed, or passed again.
  if (confirm === undefined) {
    if (!interactive) {
      throw new EveryAppError(
        TeardownCode.ConfirmationRequired,
        `Tearing down ${accountId} needs its id typed at a terminal, or --confirm ${accountId}\n${planSummary(plan)} would be deleted for good. Nothing was changed.`,
        {
          // This run's own arguments plus `--confirm <id>` (an agent adds its own --json).
          rerun: thisCommand(["--confirm", accountId]),
          rerunNote: "only for a dedicated test account",
          authorize: true,
          data: { accountId, plan: planData(plan) },
        },
      );
    }
    const typed = (await (options.askConfirmation ?? askAtTerminal)(accountId, shown)).trim().toLowerCase();
    if (typed !== accountId) {
      throw new CancelledError(
        typed ? `"${typed}" doesn't match ${accountId}. Nothing deleted.` : "Cancelled. Nothing deleted.",
      );
    }
  } else if (interactive) {
    // --confirm at a terminal: the person still sees what goes before it does.
    out.emit({
      type: "step",
      step: "teardown.plan",
      status: "ok",
      message: `Deleting everything EveryApp created in ${accountId}:`,
      data: { accountId, lines: shown },
    });
  }

  // 7. The deletions.
  const result = await executeTeardown({ cf, plan, out, ...(options.sleep ? { sleep: options.sleep } : {}) });
  out.emit({ type: "done", ...summary(accountId, plan, result) });
}

function askAtTerminal(accountId: string, shown: readonly string[]): Promise<string> {
  return askText(`Type ${accountId} to delete all of this`, {
    context: [
      `This deletes everything EveryApp created in Cloudflare account ${accountId}, for good:`,
      "",
      ...shown,
      "",
    ],
  });
}

/** The last word: what went, what stayed and where to find it. */
function summary(
  accountId: string,
  plan: TeardownPlan,
  { removed, kept }: Awaited<ReturnType<typeof executeTeardown>>,
): { message: string; display: string; data: Record<string, unknown> } {
  const message =
    kept.length === 0
      ? `Removed ${plural(removed.length, "resource")} from ${accountId}.`
      : `Removed ${plural(removed.length, "resource")} from ${accountId}; kept ${kept.length} (${listed(kept.map((item) => `${item.described}: ${item.reason}`))}).`;
  const display = [
    chalk.green(`Removed ${plural(removed.length, "resource")} from ${accountId}`),
    ...(kept.length > 0
      ? [
          "",
          `Kept ${plural(kept.length, "resource")}:`,
          ...kept.map((item) => `  ${item.described} ${chalk.dim(`· ${item.reason} · ${item.place}`)}`),
        ]
      : []),
    ...(plan.kept.length > 0 ? ["", chalk.dim(`Left as they were: ${plan.kept.join("; ")}.`)] : []),
  ].join("\n");
  return {
    message,
    display,
    data: { accountId, dryRun: false, removed, kept, plan: planData(plan) },
  };
}
