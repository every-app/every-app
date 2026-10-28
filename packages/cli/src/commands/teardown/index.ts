/**
 * `everyapp teardown --account-id <id>`: the clean slate the onboarding
 * loop needs between runs. Guards first (lib/teardown/guards.ts: a
 * forbidden id, the allowlist, a token, what the token sees), then the
 * inventory, read-only (lib/teardown/inventory.ts), shown and, unless
 * `--dry-run`, confirmed by the account id typed at the terminal or passed
 * as `--confirm`; then the deletions, kind by kind (lib/teardown/delete.ts).
 *
 * One Gateway at a time: the default one, `--gateway <name>` a named one
 * (held to fewer guards, and confirmed by its Worker's name: guards.ts says
 * why), or `--all` every Gateway in the account, the named ones first and
 * the default last.
 */
import chalk from "chalk";
import { gatewayNameOf, gatewayNames, type GatewayNames } from "@every-app/perimeter/manifest";
import { cfWhoami } from "@/lib/cf/account";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { listWorkers } from "@/lib/cf/workers";
import { CancelledError, EveryAppError } from "@/lib/errors";
import { listGatewayDatabases } from "@/lib/gateway/resources";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { askText, canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { listed, plural } from "@/lib/output/text";
import { executeTeardown } from "@/lib/teardown/delete";
import {
  checkAccountEligible,
  checkGatewayEligible,
  checkTokenScope,
  gatewayFromFlag,
  TeardownCode,
} from "@/lib/teardown/guards";
import { creatorOf, inventoryAccount } from "@/lib/teardown/inventory";
import { planData, planLines, planSummary, planTotal, type TeardownPlan } from "@/lib/teardown/plan";

interface TeardownFlags {
  "account-id": string;
  confirm?: string;
  gateway?: string;
  all?: boolean;
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
  /**
   * Asks the person at the terminal to type what confirms the run: the
   * account id, or a named Gateway's Worker name (tests answer for them).
   */
  askConfirmation?: (expected: string, planShown: readonly string[]) => Promise<string>;
  /** The environment the guards read (default: the process's); tests. */
  env?: NodeJS.ProcessEnv;
  /** Waits before the second look at a refused certificate pack (tests answer at once). */
  sleep?: (ms: number) => Promise<void>;
}

const CHECK = "teardown.check";

export async function teardown(flags: TeardownFlags): Promise<void> {
  await runCommand(flags, (out) => teardownAccount({ flags, out }));
}

/**
 * Every Gateway in the account, for `--all`: the D1 databases and Workers
 * named as a Gateway's (one whose database went already still has its
 * Worker, or the reverse), the named ones by name, then the default, always
 * (its name scan finds what a run before left, Gateway or not).
 */
async function everyGateway(cf: CfRunner): Promise<GatewayNames[]> {
  const found = new Map<string, GatewayNames>();
  for (const database of await listGatewayDatabases(cf)) {
    if (database.names.name !== null) found.set(database.names.name, database.names);
  }
  for (const worker of await listWorkers(cf)) {
    const names = gatewayNameOf(worker.name);
    if (names?.name) found.set(names.name, names);
  }
  return [...[...found.values()].sort((a, b) => a.name!.localeCompare(b.name!)), gatewayNames(null)];
}

export async function teardownAccount(options: TeardownOptions): Promise<void> {
  const { flags, out } = options;
  const env = options.env ?? process.env;
  const createCf = options.createCf ?? ((accountId?: string) => createCfRunner({ accountId, env }));
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const dryRun = flags["dry-run"] ?? false;
  const all = flags.all ?? false;

  // 0. Which Gateway, before anything else.
  if (all && flags.gateway !== undefined) {
    throw new EveryAppError(
      TeardownCode.GatewayAndAll,
      `--gateway and --all can't go together\n--gateway tears down one Gateway; --all tears down every Gateway in the account. Nothing was read or changed.`,
      { fix: "pass one of them", data: { gateway: flags.gateway } },
    );
  }
  const names = flags.gateway !== undefined ? gatewayFromFlag(flags.gateway) : gatewayNames(null);
  /** One named Gateway: no allowlist, and its Worker's name confirms (lib/teardown/guards.ts). */
  const named = names.name !== null;

  // 1–3. Before anything of Cloudflare is read.
  out.emit({ type: "step", step: CHECK, status: "start", message: "Checking the account may be torn down..." });
  const { accountId, allowlist, forbidden } = named
    ? { ...checkGatewayEligible({ accountId: flags["account-id"], names, env }), allowlist: null, forbidden: [] }
    : checkAccountEligible({ accountId: flags["account-id"], out, env });
  /** What confirms the run: the account id, or a named Gateway's Worker name. */
  const expected = named ? names.worker : accountId;
  // A confirmation that can't match is refused before any read too.
  const confirm = flags.confirm?.trim().toLowerCase();
  if (confirm !== undefined && confirm !== expected) {
    throw new EveryAppError(
      TeardownCode.ConfirmMismatch,
      named
        ? `--confirm ${flags.confirm} isn't ${names.label}'s Worker name\nIt must be ${expected} exactly. Nothing was read or changed.`
        : `--confirm ${flags.confirm} isn't the account id\nIt must repeat --account-id ${accountId} exactly. Nothing was read or changed.`,
      { fix: `pass --confirm ${expected}`, data: { accountId, gateway: names.name, confirm: flags.confirm } },
    );
  }
  // 4. What the token sees: the one read before the inventory.
  checkTokenScope({ accountId, allowlist, forbidden, whoami: await cfWhoami(createCf()) });
  out.emit({
    type: "step",
    step: CHECK,
    status: "ok",
    message: named
      ? `The token sees ${accountId}; only ${names.label}'s resources are read and deleted`
      : `${accountId} is a test account, and the token sees it alone`,
    data: { accountId, gateway: names.name },
  });

  // 5. The inventory, read-only: each Gateway's.
  const cf = createCf(accountId);
  const targets = all ? await everyGateway(cf) : [names];
  const plans: TeardownPlan[] = [];
  for (const target of targets) plans.push(await inventoryAccount({ cf, accountId, names: target, out }));
  const total = plans.reduce((sum, plan) => sum + planTotal(plan), 0);
  const shown = all
    ? plans.flatMap((plan, index) => [
        ...(index > 0 ? [""] : []),
        chalk.bold(`${creatorOf(targets[index]!)}${targets[index]!.name === null ? " (the default Gateway)" : ""}:`),
        ...planLines(plan),
      ])
    : planLines(plans[0]!);
  const creator = all ? "EveryApp" : creatorOf(names);
  const summaryOf = () => (all ? plural(total, "resource") : planSummary(plans[0]!));
  /** `data.plan` for one Gateway, `data.plans` for --all. */
  const planFields = (): Record<string, unknown> =>
    all ? { plans: plans.map(planData) } : { plan: planData(plans[0]!) };
  const base = { accountId, gateway: all ? null : names.name, all };

  if (dryRun) {
    const message =
      total === 0
        ? `Nothing of ${creator} is left in ${accountId}.`
        : `Dry run: ${summaryOf()} would be removed from ${accountId}. Nothing was changed.`;
    out.emit({
      type: "done",
      message,
      display: [
        chalk.bold(total === 0 ? message : `Would remove ${summaryOf()} from ${accountId}`),
        ...(total === 0 && !all ? shown.slice(1) : shown),
        ...(total === 0 ? [] : ["", chalk.dim("Nothing was changed (--dry-run).")]),
      ].join("\n"),
      data: { ...base, dryRun: true, removed: [], kept: [], ...planFields() },
    });
    return;
  }
  if (total === 0) {
    const message = `Nothing of ${creator} is left in ${accountId}.`;
    out.emit({
      type: "done",
      message,
      display: [chalk.green(message), ...(all ? [] : shown.slice(1))].join("\n"),
      data: { ...base, dryRun: false, removed: [], kept: [], ...planFields() },
    });
    return;
  }

  // 6. The confirmation: the id (a named Gateway's Worker name) typed, or passed again.
  if (confirm === undefined) {
    if (!interactive) {
      throw new EveryAppError(
        TeardownCode.ConfirmationRequired,
        named
          ? `Tearing down ${names.label} needs its Worker name typed at a terminal, or --confirm ${expected}\n${summaryOf()} would be deleted for good from ${accountId}. Nothing was changed.`
          : `Tearing down ${accountId} needs its id typed at a terminal, or --confirm ${accountId}\n${summaryOf()} would be deleted for good. Nothing was changed.`,
        {
          // This run's own arguments plus `--confirm <id>` (an agent adds its own --json).
          rerun: thisCommand(["--confirm", expected]),
          rerunNote: named ? `only to delete ${names.label} and its apps` : "only for a dedicated test account",
          authorize: true,
          data: { ...base, ...planFields() },
        },
      );
    }
    const ask = options.askConfirmation ?? ((value, lines) => askAtTerminal(value, lines, named ? names : null, accountId));
    const typed = (await ask(expected, shown)).trim().toLowerCase();
    if (typed !== expected) {
      throw new CancelledError(
        typed ? `"${typed}" doesn't match ${expected}. Nothing deleted.` : "Cancelled. Nothing deleted.",
      );
    }
  } else if (interactive) {
    // --confirm at a terminal: the person still sees what goes before it does.
    out.emit({
      type: "step",
      step: "teardown.plan",
      status: "ok",
      message: `Deleting everything ${creator} created in ${accountId}:`,
      data: { accountId, gateway: base.gateway, lines: shown },
    });
  }

  // 7. The deletions, Gateway by Gateway. After the first, each Gateway is
  // read again just before it goes: the one before may have changed what
  // its plan saw (a zone's mail rules, say).
  const removed: string[] = [];
  const kept: Awaited<ReturnType<typeof executeTeardown>>["kept"] = [];
  for (const [index, target] of targets.entries()) {
    const plan = index === 0 ? plans[0]! : await inventoryAccount({ cf, accountId, names: target, out });
    plans[index] = plan;
    const result = await executeTeardown({ cf, plan, out, ...(options.sleep ? { sleep: options.sleep } : {}) });
    removed.push(...result.removed);
    kept.push(...result.kept);
  }
  out.emit({ type: "done", ...summary(accountId, plans, { removed, kept }, base, planFields) });
}

function askAtTerminal(
  expected: string,
  shown: readonly string[],
  named: GatewayNames | null,
  accountId: string,
): Promise<string> {
  return askText(`Type ${expected} to delete all of this`, {
    context: [
      named
        ? `This deletes everything ${named.label} created in Cloudflare account ${accountId}, for good:`
        : `This deletes everything EveryApp created in Cloudflare account ${accountId}, for good:`,
      "",
      ...shown,
      "",
    ],
  });
}

/** The last word: what went, what stayed and where to find it. */
function summary(
  accountId: string,
  plans: readonly TeardownPlan[],
  { removed, kept }: Awaited<ReturnType<typeof executeTeardown>>,
  base: Record<string, unknown>,
  planFields: () => Record<string, unknown>,
): { message: string; display: string; data: Record<string, unknown> } {
  const message =
    kept.length === 0
      ? `Removed ${plural(removed.length, "resource")} from ${accountId}.`
      : `Removed ${plural(removed.length, "resource")} from ${accountId}; kept ${kept.length} (${listed(kept.map((item) => `${item.described}: ${item.reason}`))}).`;
  const leftAlone = [...new Set(plans.flatMap((plan) => plan.kept))];
  const display = [
    chalk.green(`Removed ${plural(removed.length, "resource")} from ${accountId}`),
    ...(kept.length > 0
      ? [
          "",
          `Kept ${plural(kept.length, "resource")}:`,
          ...kept.map((item) => `  ${item.described} ${chalk.dim(`· ${item.reason} · ${item.place}`)}`),
        ]
      : []),
    ...(leftAlone.length > 0 ? ["", chalk.dim(`Left as they were: ${leftAlone.join("; ")}.`)] : []),
  ].join("\n");
  return {
    message,
    display,
    data: { ...base, dryRun: false, removed, kept, ...planFields() },
  };
}
