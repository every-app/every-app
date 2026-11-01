/**
 * `pnpm loop <command>` (design 4.1, build spec item 3): run, doctor,
 * accounts, teardown, verify, reparse, replay, answer, collect, report,
 * findings, gc. A hand-rolled arg parser (commands.ts); every line the
 * driver prints goes through the run's redactor in run.ts, and the other
 * commands print nothing that was ever a secret.
 */
import {
  accountsMain,
  AccountsError,
  configDir,
  loadAccountsFile,
  loadProviders,
} from "./accounts";
import {
  dockerOrNull,
  parseArgs,
  teardownMain,
  type ParsedArgs,
} from "./commands";
import { createAuthoritativeDns } from "./dns";
import { DockerError } from "./docker";
import { doctorMain } from "./doctor";
import { isHarnessName, HARNESS_NAMES } from "./harnesses/index";
import { createHttpFetch } from "./httpFetch";
import {
  answerMain,
  collectMain,
  findingsMain,
  gcMain,
  recomputeMain,
  reportMain,
  verifyMain,
} from "./maintenance";
import { createRedactor, type Redactor, type Secret } from "./redact";
import {
  DEFAULT_RUN_OPTIONS,
  defaultRunDeps,
  DOCKERFILE,
  REPO_ROOT,
  runLoop,
  type RunOptions,
} from "./run";
import { TeardownStepError } from "./teardownStep";
import { SiblingError, TokenGateError } from "./withTestAccount";

/**
 * The one redactor every line the CLI prints goes through, including the
 * error handler's: made from every value in accounts.json and providers.env
 * when they exist (a command that never loads them still gets the shapes).
 */
function cliRedactor(dir: string): Redactor {
  const secrets: Secret[] = [];
  try {
    for (const account of loadAccountsFile(dir).accounts)
      secrets.push({ name: "cf_token", value: account.token });
  } catch {
    // No accounts.json, or an invalid one: the command that needs it says so.
  }
  try {
    for (const value of Object.values(loadProviders(dir)))
      if (typeof value === "string" && value)
        secrets.push({ name: "provider_key", value });
  } catch {
    // No providers.env: nothing more to redact by value.
  }
  return createRedactor(secrets);
}

/** Errors whose message is the whole story: no stack, which could embed a request or an output. */
const PLAIN_ERRORS = [
  AccountsError,
  TokenGateError,
  TeardownStepError,
  DockerError,
  SiblingError,
];

/** The one print that reaches stderr on failure: redacted, and only the message for the loop's own errors. */
function fail(redactor: Redactor, command: string, error: unknown): void {
  const message =
    error instanceof Error
      ? PLAIN_ERRORS.some((kind) => error instanceof kind)
        ? error.message
        : (error.stack ?? error.message)
      : String(error);
  process.stderr.write(redactor.redact(`loop ${command}: ${message}\n`));
}

const USAGE = `usage: pnpm loop <command> [options]

  run --harness <${HARNESS_NAMES.join("|")}> [--account <name>] [--model <id>]
      [--ref <commit>] [--tools-ref <commit>] [--mode defaults] [--with-access]
      [--claim-after immediate|turn-end] [--no-event-log] [--prompt-variant checkout-present|public]
      [--repeat-on-infra <n>] [--keep] [--parallel <n>] [--dry-run] [--no-wait]
                          one run: wipe, sandbox, harness, scripted user, claim, verify, wipe, record.
                          --dry-run stops after preflight (a stub account when accounts.json is absent)
  doctor [--rebuild]      build the image if its tag is missing; check every harness's line against --help in it
  accounts                the accounts and provider keys found (names and zones; never an id or a token)
  teardown --account <name> [--dry-run] [--force] [--ref <commit>]
                          wipe a test account through everyapp teardown in a sibling container
  verify <runId>          the outside-in probes again (O1, A3, S1 cannot pass again; see README)
  reparse <runId>         today's normalizers and rules over the saved harness lines; re-decide
  replay <runId>          today's decision table over the saved events and verify.json
  answer <runId> "<text>" a person's reply to a running harness, sent at its next turn end
  collect <runId>         /loop, session stores and the diff out of a container kept with --keep
  report                  docs/onboarding-loop: one whitelisted JSON per run, findings.json, README, findings.md
  findings [runId] [--onboarding-dx <threadId>] [--agent-docs <threadId>]
                          the hand-off text per destination for one run (the newest by default)
  gc [--days <n>]         old run directories (30 days), stale locks, loop-* containers, temp dirs
`;

const COMMANDS = [
  "run",
  "doctor",
  "accounts",
  "teardown",
  "verify",
  "reparse",
  "replay",
  "answer",
  "collect",
  "report",
  "findings",
  "gc",
] as const;

const flag = (args: ParsedArgs, name: string): string | null =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : null;
const bool = (args: ParsedArgs, name: string): boolean =>
  args.flags[name] === true;

/** `run`'s flags to RunOptions, each checked. */
export function runOptionsFrom(args: ParsedArgs): RunOptions {
  const harness = flag(args, "harness");
  if (!harness || !isHarnessName(harness))
    throw new Error(`--harness must be one of ${HARNESS_NAMES.join(", ")}`);
  const mode = flag(args, "mode") ?? DEFAULT_RUN_OPTIONS.mode;
  if (mode !== "defaults" && mode !== "raised")
    throw new Error("--mode must be defaults or raised");
  const claimAfter =
    flag(args, "claim-after") ?? DEFAULT_RUN_OPTIONS.claimAfter;
  if (claimAfter !== "immediate" && claimAfter !== "turn-end")
    throw new Error("--claim-after must be immediate or turn-end");
  const promptVariant =
    flag(args, "prompt-variant") ?? DEFAULT_RUN_OPTIONS.promptVariant;
  if (promptVariant !== "checkout-present" && promptVariant !== "public")
    throw new Error("--prompt-variant must be checkout-present or public");
  const number = (name: string, fallback: number): number => {
    const value = flag(args, name);
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new Error(`--${name} must be a whole number`);
    return parsed;
  };
  return {
    harness,
    account: flag(args, "account"),
    model: flag(args, "model"),
    ref: flag(args, "ref") ?? DEFAULT_RUN_OPTIONS.ref,
    toolsRef: flag(args, "tools-ref") ?? DEFAULT_RUN_OPTIONS.toolsRef,
    mode,
    withAccess: bool(args, "with-access"),
    claimAfter,
    eventLog: !bool(args, "no-event-log"),
    promptVariant,
    repeatOnInfra: number("repeat-on-infra", DEFAULT_RUN_OPTIONS.repeatOnInfra),
    keep: bool(args, "keep"),
    parallel: number("parallel", DEFAULT_RUN_OPTIONS.parallel),
    dryRun: bool(args, "dry-run"),
    wait: !bool(args, "no-wait"),
    retryOf: null,
  };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`loop: unknown command "${command}"\n${USAGE}`);
    return 2;
  }
  const args = parseArgs(argv.slice(1));
  if (bool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dir = configDir();
  const redactor = cliRedactor(dir);
  const log = (line: string): void => {
    process.stdout.write(`${redactor.redact(line)}\n`);
  };
  const runsRoot = `${dir}/runs`;
  const runId = args.positional[0] ?? null;
  const needRunId = (): string => {
    if (!runId) throw new Error(`usage: pnpm loop ${command} <runId>`);
    return runId;
  };
  const createFetch = () =>
    createHttpFetch({ lookup: createAuthoritativeDns().lookup });

  switch (command) {
    case "run": {
      const options = runOptionsFrom(args);
      if (options.parallel > 1)
        log(
          "--parallel: preflight checks the memory for it; running two lanes at once is not built, this is one run",
        );
      const outcome = await runLoop(options, defaultRunDeps(log));
      return outcome.exitCode;
    }
    case "doctor":
      return doctorMain({
        dockerfile: DOCKERFILE,
        rebuild: bool(args, "rebuild"),
        log,
      });
    case "accounts":
      for (const line of accountsMain()) log(line);
      return 0;
    case "teardown":
      return teardownMain(args, log);
    case "verify":
      return verifyMain({
        runsRoot,
        configDir: dir,
        runId: needRunId(),
        createFetch,
        log,
      });
    case "reparse":
      return recomputeMain({
        runsRoot,
        runId: needRunId(),
        renormalize: true,
        log,
      });
    case "replay":
      return recomputeMain({
        runsRoot,
        runId: needRunId(),
        renormalize: false,
        log,
      });
    case "answer": {
      const text = args.positional.slice(1).join(" ");
      if (!text) throw new Error('usage: pnpm loop answer <runId> "<text>"');
      return answerMain({ runsRoot, runId: needRunId(), text, log });
    }
    case "collect":
      return collectMain({
        runsRoot,
        configDir: dir,
        runId: needRunId(),
        docker: dockerOrNull(redactor),
        log,
      });
    case "report":
      return reportMain({ runsRoot, repoRoot: REPO_ROOT, log });
    case "findings":
      return findingsMain({
        runsRoot,
        repoRoot: REPO_ROOT,
        configDir: dir,
        runId,
        threadIds: {
          ...(flag(args, "onboarding-dx")
            ? { onboardingDx: flag(args, "onboarding-dx")! }
            : {}),
          ...(flag(args, "agent-docs")
            ? { agentDocs: flag(args, "agent-docs")! }
            : {}),
        },
        log,
      });
    case "gc":
      return gcMain({
        runsRoot,
        configDir: dir,
        docker: dockerOrNull(redactor),
        days: Number(flag(args, "days") ?? 30),
        now: Date.now(),
        log,
      });
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    fail(cliRedactor(configDir()), process.argv[2] ?? "", error);
    process.exit(1);
  },
);
