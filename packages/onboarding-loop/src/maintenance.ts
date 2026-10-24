/**
 * The commands that work on runs already made (design 4.9 to 4.11): the
 * committed report, the hand-off text, a re-parse of saved artifacts with
 * today's normalizers and rules, a replay of the decision over saved
 * evidence, a person's answer to a running harness, collection from a kept
 * container, a re-run of the outside-in probes, and garbage collection.
 * Nothing here needs an account except `verify`, `collect` and `gc`'s
 * docker step; everything reads the run directory and writes there or
 * under docs/onboarding-loop.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findAccount,
  loadAccountsFile,
  loadProviders,
  locksDir,
  sha256,
  type RotateFile,
} from "./accounts";
import { assemble, type AssembleInput } from "./assemble";
import { ownerCredentials, parseEventLogLine } from "./claim";
import type { Docker } from "./docker";
import { liveLocks, lockIsLive, type LockInfo } from "./lock";
import {
  emptyLedger,
  mergeFindings,
  renderHandoff,
  withStatuses,
} from "./findings";
import { createHarness } from "./harnesses/index";
import {
  listRunRecords,
  readRunRecord,
  runDir,
  RUN_FILES,
  writeRunRecord,
} from "./record";
import { createRedactor, exposed, type Secret } from "./redact";
import { REPORT_DIR, writeReport } from "./report";
import type { SavedAssembleInput } from "./run";
import { redactTree, TEMPLATE_MARKER } from "./run";
import { containerName, containerOwnedByRun } from "./sandbox";
import { verify } from "./verify";
import type {
  DiffEntry,
  FetchLike,
  FindingsLedger,
  NormalizedEvent,
  RunRecord,
  VerifyResult,
} from "./types";

type Log = (line: string) => void;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The ledger on disk folded with every run on this machine, statuses recomputed. */
function buildLedger(repoRoot: string, records: RunRecord[]): FindingsLedger {
  const file = path.join(repoRoot, REPORT_DIR, "findings.json");
  const onDisk = readJson<FindingsLedger>(file);
  let ledger: FindingsLedger =
    onDisk && onDisk.v === 1 && Array.isArray(onDisk.findings)
      ? onDisk
      : emptyLedger();
  for (const record of records) ledger = mergeFindings(ledger, record);
  return withStatuses(ledger, records);
}

/** `pnpm loop report`: docs/onboarding-loop from every run.json under the runs root. */
export function reportMain(deps: {
  runsRoot: string;
  repoRoot: string;
  log: Log;
}): number {
  const records = listRunRecords(deps.runsRoot);
  const ledger = buildLedger(deps.repoRoot, records);
  const written = writeReport(deps.repoRoot, records, ledger, (runId, why) =>
    deps.log(`not committed: ${runId}: ${why}`),
  );
  for (const file of written) deps.log(`wrote ${file}`);
  deps.log(`${records.length} run(s), ${ledger.findings.length} finding(s)`);
  return 0;
}

/** `pnpm loop findings [runId]`: the hand-off text for one run (the newest by default). */
export function findingsMain(deps: {
  runsRoot: string;
  repoRoot: string;
  configDir: string;
  runId: string | null;
  threadIds: { onboardingDx?: string; agentDocs?: string };
  log: Log;
}): number {
  const records = listRunRecords(deps.runsRoot);
  const target = deps.runId
    ? records.find((r) => r.runId === deps.runId)
    : [...records]
        .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
        .at(-1);
  if (!target) {
    deps.log(
      deps.runId
        ? `no run ${deps.runId} under ${deps.runsRoot}`
        : "no runs yet",
    );
    return 1;
  }
  const ledger = buildLedger(deps.repoRoot, records);
  const text = renderHandoff(target.runId, ledger, deps.threadIds);
  const dir = path.join(deps.configDir, "handoff");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${target.runId}.md`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  for (const line of text.split("\n")) deps.log(line);
  deps.log(`written to ${file}`);
  return 0;
}

/** events.jsonl back into events per process. */
function readProcesses(dir: string): NormalizedEvent[][] {
  const text = fs.existsSync(path.join(dir, RUN_FILES.events))
    ? fs.readFileSync(path.join(dir, RUN_FILES.events), "utf8")
    : "";
  const processes: NormalizedEvent[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const { processIndex, ...event } = JSON.parse(line) as NormalizedEvent & {
        processIndex: number;
      };
      while (processes.length <= processIndex) processes.push([]);
      processes[processIndex]!.push(event);
    } catch {
      // A half line from a dead driver: skipped.
    }
  }
  return processes;
}

/** harness.raw.redacted.jsonl through a fresh adapter per process: today's normalizer over yesterday's lines. */
function renormalize(
  dir: string,
  record: RunRecord,
  exits: SavedAssembleInput["exits"],
): NormalizedEvent[][] | null {
  const file = path.join(dir, RUN_FILES.harnessRaw);
  if (!fs.existsSync(file)) return null;
  const processes: NormalizedEvent[][] = [];
  const adapters = new Map<number, ReturnType<typeof createHarness>>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let raw: {
      processIndex: number;
      stream: "stdout" | "stderr";
      receivedAt: string;
      line: string;
    };
    try {
      raw = JSON.parse(line) as typeof raw;
    } catch {
      continue;
    }
    let adapter = adapters.get(raw.processIndex);
    if (!adapter) {
      adapter = createHarness(record.harness.name);
      adapters.set(raw.processIndex, adapter);
    }
    while (processes.length <= raw.processIndex) processes.push([]);
    processes[raw.processIndex]!.push(
      ...adapter.normalize(raw.line, raw.stream, raw.receivedAt),
    );
  }
  for (const [index, adapter] of adapters) {
    const exit = exits[index];
    processes[index]!.push(
      ...(adapter.onExit?.(exit?.exitCode ?? null, record.finishedAt) ?? []),
    );
  }
  return processes;
}

/**
 * `loop reparse <runId>` (renormalize: true) and `loop replay <runId>`
 * (false): the record rebuilt from the saved artifacts with the current
 * parsers, rules, verifier evidence and decision table; the old verdict
 * and the new one are printed side by side.
 */
export function recomputeMain(deps: {
  runsRoot: string;
  runId: string;
  renormalize: boolean;
  log: Log;
}): number {
  const dir = runDir(deps.runsRoot, deps.runId);
  const record = readRunRecord(deps.runsRoot, deps.runId);
  const saved = readJson<SavedAssembleInput>(
    path.join(dir, RUN_FILES.assembleInput),
  );
  if (!saved) {
    deps.log(
      `${deps.runId} has no ${RUN_FILES.assembleInput}: made by an older driver, nothing to recompute from`,
    );
    return 1;
  }
  const eventLogText = fs.existsSync(path.join(dir, RUN_FILES.eventLog))
    ? fs.readFileSync(path.join(dir, RUN_FILES.eventLog), "utf8")
    : "";
  const eventLog = eventLogText.split("\n").flatMap((line) => {
    const parsed = parseEventLogLine(line);
    return parsed ? [parsed] : [];
  });
  const processes =
    (deps.renormalize ? renormalize(dir, record, saved.exits) : null) ??
    readProcesses(dir);
  const verifyResult = readJson<VerifyResult>(path.join(dir, RUN_FILES.verify));
  const input: AssembleInput = {
    ...saved,
    seed: record,
    eventLog,
    processes,
    verify: verifyResult,
  };
  const { record: next, decision } = assemble(input);
  fs.writeFileSync(
    path.join(dir, RUN_FILES.decideInput),
    `${JSON.stringify(decision, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeRunRecord(deps.runsRoot, next);
  const was = `${record.verdict.value}${record.verdict.reasonCode ? ` (${record.verdict.reasonCode})` : ""}`;
  const now = `${next.verdict.value}${next.verdict.reasonCode ? ` (${next.verdict.reasonCode})` : ""}`;
  deps.log(
    `${deps.runId}: verdict ${was} -> ${now}; hesitations ${record.hesitations.length} -> ${next.hesitations.length}; everyapp commands ${record.everyappCommands.length} -> ${next.everyappCommands.length}; versions ${JSON.stringify(next.versions)}`,
  );
  return 0;
}

/** `loop answer <runId> "<text>"`: queued for the running driver, consumed at the next turn end. */
export function answerMain(deps: {
  runsRoot: string;
  runId: string;
  text: string;
  log: Log;
}): number {
  const dir = runDir(deps.runsRoot, deps.runId);
  if (!fs.existsSync(dir)) {
    deps.log(`no run ${deps.runId} under ${deps.runsRoot}`);
    return 1;
  }
  if (fs.existsSync(path.join(dir, RUN_FILES.record))) {
    deps.log(
      `${deps.runId} has finished (run.json exists): an answer now reaches nobody`,
    );
    return 1;
  }
  const answers = path.join(dir, "answers");
  fs.mkdirSync(answers, { recursive: true, mode: 0o700 });
  const file = path.join(answers, `${Date.now()}.txt`);
  fs.writeFileSync(file, `${deps.text}\n`, { mode: 0o600 });
  deps.log(
    `queued for ${deps.runId}; the driver sends it when the current turn ends (recorded as an intervention by a person)`,
  );
  return 0;
}

/** `loop collect <runId>`: /loop, the session stores and the diff out of a container kept with --keep. */
export async function collectMain(deps: {
  runsRoot: string;
  configDir: string;
  runId: string;
  docker: Docker | null;
  log: Log;
}): Promise<number> {
  if (!deps.docker) {
    deps.log("docker: not found at Docker Desktop's paths or on PATH");
    return 1;
  }
  const dir = runDir(deps.runsRoot, deps.runId);
  const name = containerName(deps.runId);
  const containers = await deps.docker.listContainers(name);
  if (!containers.includes(name)) {
    deps.log(
      `no container ${name}: the run was not kept (--keep), or it was removed`,
    );
    return 1;
  }
  const record = fs.existsSync(path.join(dir, RUN_FILES.record))
    ? readRunRecord(deps.runsRoot, deps.runId)
    : null;
  // Every exact value the driver holds, as in a run: the account's token and every provider key
  // (OpenCode Zen and Cursor keys have no shape the redactor knows; only the value catches them).
  const secrets: Secret[] = [];
  let account: ReturnType<typeof findAccount> | null = null;
  try {
    account = record
      ? findAccount(loadAccountsFile(deps.configDir), record.account.name)
      : null;
    if (account) secrets.push({ name: "cf_token", value: account.token });
  } catch {
    // No accounts.json: the shape rules still apply.
  }
  let providerSecrets: Secret[] = [];
  try {
    providerSecrets = Object.values(loadProviders(deps.configDir))
      .filter((value): value is string => typeof value === "string" && !!value)
      .map((value) => ({ name: "provider_key" as const, value }));
  } catch {
    // No providers.env: nothing more to redact by value.
  }
  const redactor = createRedactor([...secrets, ...providerSecrets]);
  const handle = { id: name, name };
  const sandbox = deps.docker.sandbox;
  const collected = path.join(dir, "collected-again");
  fs.mkdirSync(collected, { recursive: true, mode: 0o700 });
  await sandbox.copyOut(handle, "/loop", path.join(collected, "loop"));
  for (const p of record
    ? createHarness(record.harness.name).collectPaths
    : []) {
    fs.mkdirSync(path.join(collected, "home", path.dirname(p)), {
      recursive: true,
      mode: 0o700,
    });
    await sandbox
      .copyOut(handle, `/home/dev/${p}`, path.join(collected, "home", p))
      .catch(() => undefined);
  }
  const diff = await sandbox.diff(handle);
  fs.writeFileSync(
    path.join(dir, "diff.again.txt"),
    `${diff.map((e) => `${e.kind[0]!.toUpperCase()} ${e.path}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  const files = redactTree(collected, redactor, deps.log);
  deps.log(
    `collected ${files} file(s) into ${collected}, ${diff.length} diff entries; redacted`,
  );
  // As finish() does: a token or key echoed in what was collected writes rotate.json and prints ROTATE:.
  const exposure = redactor.exposure();
  if (exposure.cf_token > 0 || exposure.provider_key > 0) {
    const values: RotateFile["values"] = [];
    if (exposure.cf_token > 0 && account)
      values.push({ name: "cf_token", sha256: sha256(account.token) });
    if (exposure.provider_key > 0)
      for (const secret of providerSecrets)
        values.push({ name: "provider_key", sha256: sha256(secret.value) });
    fs.writeFileSync(
      path.join(dir, RUN_FILES.rotate),
      `${JSON.stringify({ values }, null, 2)}\n`,
      { mode: 0o600 },
    );
    deps.log(
      `ROTATE: ${exposure.cf_token > 0 ? "the Cloudflare token" : "a provider key"}${exposure.cf_token > 0 && exposure.provider_key > 0 ? " and a provider key" : ""} of this run was echoed in the collected files; roll it (runbook section 8) and the loop refuses it until then`,
    );
  }
  if (exposed(exposure))
    deps.log(`secret exposure counters: ${JSON.stringify(exposure)}`);
  return 0;
}

/**
 * `loop verify <runId>`: the outside-in probes again, against the run's
 * account and app host. O1 and A3 cannot pass again: the owner password
 * lived only in the run that made it, so a fresh one is used and those
 * rows are expected to fail. S1 needs a sibling container; without docker
 * it is reported as not run. The result goes to verify-rerun.json and the
 * record is left alone.
 */
export async function verifyMain(deps: {
  runsRoot: string;
  configDir: string;
  runId: string;
  createFetch: (zone: string) => FetchLike;
  log: Log;
}): Promise<number> {
  const dir = runDir(deps.runsRoot, deps.runId);
  const record = readRunRecord(deps.runsRoot, deps.runId);
  const account = findAccount(
    loadAccountsFile(deps.configDir),
    record.account.name,
  );
  const diffText = fs.existsSync(path.join(dir, RUN_FILES.diff))
    ? fs.readFileSync(path.join(dir, RUN_FILES.diff), "utf8")
    : "";
  const diff: DiffEntry[] = diffText.split("\n").flatMap((line) => {
    const match = /^([ACD]) (.+)$/.exec(line);
    if (!match) return [];
    return [
      {
        kind:
          match[1] === "A" ? "added" : match[1] === "C" ? "changed" : "deleted",
        path: match[2]!,
      },
    ];
  });
  const result = await verify(
    {
      zone: account.zone,
      gatewayOrigin: `https://apps.${account.zone}`,
      appHost: record.steps.app.url
        ? new URL(record.steps.app.url).hostname
        : null,
      owner: ownerCredentials(account.email),
      claimHow: record.steps.claim.how,
      diff,
      events: readProcesses(dir).flat(),
      harnessDeployedApp: record.steps.app.by === "harness",
      withAccess: false,
      team: null,
      templateMarker: TEMPLATE_MARKER,
    },
    {
      fetchImpl: deps.createFetch(account.zone),
      runStatus: async () => ({ exitCode: null, data: null, events: [] }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      windowMs: 60_000,
    },
  );
  fs.writeFileSync(
    path.join(dir, "verify-rerun.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  deps.log(
    `${Object.values(result.rows)
      .map((r) => `${r.id}=${r.status}`)
      .join(
        " ",
      )} (O1, A3 and S1 cannot pass in a re-run: no owner password, no sibling container)`,
  );
  return 0;
}

/** `loop gc [--days n]`: old run directories, stale locks, loop-* containers no live run owns, leftover temp dirs. */
export async function gcMain(deps: {
  runsRoot: string;
  configDir: string;
  docker: Docker | null;
  days: number;
  now: number;
  log: Log;
}): Promise<number> {
  const cutoff = deps.now - deps.days * 24 * 60 * 60 * 1000;
  let removed = 0;
  if (fs.existsSync(deps.runsRoot)) {
    for (const name of fs.readdirSync(deps.runsRoot)) {
      const dir = path.join(deps.runsRoot, name);
      const record = readJson<RunRecord>(path.join(dir, RUN_FILES.record));
      const stamp = record
        ? Date.parse(record.finishedAt)
        : fs.statSync(dir).mtimeMs;
      if (stamp < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
        deps.log(`removed run ${name}`);
      }
    }
  }
  const locks = locksDir(deps.configDir);
  const live = liveLocks(locks, deps.now);
  if (fs.existsSync(locks)) {
    for (const name of fs.readdirSync(locks)) {
      if (!name.endsWith(".json") || name.endsWith(".state.json")) continue;
      const file = path.join(locks, name);
      const lock = readJson<LockInfo>(file);
      if (!lockIsLive(lock, deps.now)) {
        fs.rmSync(file, { force: true });
        deps.log(`removed stale lock ${name}`);
      }
    }
  }
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith("everyapp-loop-")) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs < deps.now - 24 * 60 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        deps.log(`removed temp ${name}`);
      }
    } catch {
      // Gone already.
    }
  }
  if (deps.docker) {
    // Running or not, but never a container of a run that still holds its lock (the other lane).
    const liveRuns = live.map((lock) => lock.runId);
    const containers = (await deps.docker.listContainers("loop-")).filter(
      (name) => !containerOwnedByRun(name, liveRuns),
    );
    if (containers.length > 0) {
      await deps.docker.removeContainers(containers);
      deps.log(`removed container(s) ${containers.join(", ")}`);
    }
  }
  deps.log(`gc done: ${removed} run(s) removed (older than ${deps.days} days)`);
  return 0;
}
