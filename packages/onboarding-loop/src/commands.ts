/**
 * `pnpm loop teardown` on its own (the wipe in a sibling container, outside
 * a run) and the arg parser every command shares. `run` and `run --dry-run`
 * are run.ts; the commands over finished runs are maintenance.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountsError,
  configDir,
  confirmPath,
  findAccount,
  loadAccountsFile,
  locksDir,
  refuseInheritedEnv,
} from "./accounts";
import { createCfApi } from "./cf";
import {
  createDocker,
  imageTag,
  resolveDockerBinary,
  type Docker,
} from "./docker";
import { affectsDns, knownLocks, recordTeardown } from "./lock";
import { createRedactor, type Redactor } from "./redact";
import { DOCKERFILE, PACKAGE_DIR, REPO_ROOT } from "./run";
import { spawnProcess } from "./spawn";
import {
  confirmFromTty,
  readConfirmFile,
  runTeardownStep,
  TeardownStepError,
} from "./teardownStep";
import {
  createBundle,
  TokenGateError,
  withTestAccount,
} from "./withTestAccount";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** `--key value`, `--key=value`, `--flag`; the rest positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[key!] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--"))
      flags[key!] = argv[++i]!;
    else flags[key!] = true;
  }
  return { positional, flags };
}

/** A teardown's own run id: the minute, what it is, six random characters. */
const teardownRunId = (): string =>
  `${new Date().toISOString().slice(0, 16)}-teardown-${Math.random().toString(16).slice(2, 8)}`;

type Log = (line: string) => void;

export function dockerOrNull(redactor: Redactor): Docker | null {
  const binary = resolveDockerBinary();
  return binary ? createDocker({ binary, redact: redactor.redact }) : null;
}

/** `pnpm loop teardown --account <name> [--dry-run] [--force] [--ref <commit>]`. */
export async function teardownMain(
  args: ParsedArgs,
  log: Log,
): Promise<number> {
  refuseInheritedEnv();
  const dir = configDir();
  const name = args.flags["account"];
  if (typeof name !== "string") {
    log(
      "usage: pnpm loop teardown --account <name> [--dry-run] [--force] [--ref <commit>]",
    );
    return 2;
  }
  const account = findAccount(loadAccountsFile(dir), name);
  const redactor = createRedactor([{ name: "cf_token", value: account.token }]);
  const docker = dockerOrNull(redactor);
  if (!docker) {
    log("docker: not found at Docker Desktop's paths or on PATH");
    return 1;
  }
  const image = imageTag(DOCKERFILE);
  if (!(await docker.imageExists(image))) {
    log(`building ${image} (first time)`);
    await docker.build({
      dockerfile: DOCKERFILE,
      context: PACKAGE_DIR,
      tag: image,
    });
  }
  const ref =
    typeof args.flags["ref"] === "string" ? args.flags["ref"] : "HEAD";
  const bundleDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "everyapp-loop-bundle-"),
  );
  const bundlePath = path.join(bundleDir, "launch.bundle");
  const runId = teardownRunId();
  const dryRunOnly = args.flags["dry-run"] === true;
  try {
    const { commit } = await createBundle(
      spawnProcess,
      REPO_ROOT,
      ref,
      bundlePath,
    );
    log(`bundle of ${ref} (${commit.slice(0, 8)}) for the sibling container`);
    const cf = createCfApi({
      token: account.token,
      accountId: account.accountId,
    });
    const result = await withTestAccount(
      {
        sandbox: docker.sandbox,
        image,
        account,
        runId,
        allowlist: true,
        bundlePath,
        cf,
      },
      (sibling) =>
        runTeardownStep({
          sibling,
          account,
          runId,
          cf,
          dryRunOnly,
          force: args.flags["force"] === true,
          // A marker whose run's lock died here is a dead driver's: wiped without --force. One with
          // no lock here at all may be another machine's run: refused for 2 hours.
          locks: knownLocks(locksDir(dir)),
          confirm: async () => {
            const fromFile = readConfirmFile(
              confirmPath(dir, account.accountId),
              account.accountId,
            );
            if (fromFile) {
              log(`confirmation from ${confirmPath(dir, account.accountId)}`);
              return fromFile;
            }
            return confirmFromTty(account.accountId);
          },
        }),
    );
    log(
      `before: ${result.before.total} resource(s)${result.before.items.length ? `: ${result.before.items.map((i) => `${i.kind} ${i.name}`).join(", ")}` : ""}`,
    );
    if (result.removed.length > 0 || result.polls > 0) {
      log(
        `removed ${result.removed.length}, kept ${result.kept.length}, ${result.polls} poll(s); after: ${result.after.total}`,
      );
      if (affectsDns(result.removed))
        recordTeardown(
          locksDir(dir),
          account.accountId,
          new Date().toISOString(),
        );
    }
    for (const line of result.skipped) log(`skipped ${line}`);
    log(
      `dns at or under apps.${account.zone}: ${result.dnsLeftovers.length} record(s)`,
    );
    return 0;
  } catch (error) {
    if (
      error instanceof TeardownStepError ||
      error instanceof TokenGateError ||
      error instanceof AccountsError
    ) {
      log(redactor.redact(`teardown: ${error.message}`));
      return 1;
    }
    throw error;
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}
