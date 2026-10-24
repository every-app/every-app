/**
 * Preflight (design 4.2 step 1): everything that can be checked before a
 * run creates anything, in order, stopping at the first failure. Without a
 * real account (--dry-run) every check that needs the network is skipped
 * with its reason and the rest still runs: the environment, the files, the
 * forbidden id, the rotate markers, the lock, the 30-minute gap, Docker's
 * memory and version, stale `loop-*` containers, the container clock, the
 * listeners a container could reach. With one, the token gate (cf.ts) and
 * the zone, plan, workers.dev and docs checks run from the host over typed
 * fetch, never the host's `cf`. A failed preflight is `fail-infra` with
 * its reason code and runs nothing.
 */
import {
  readRotateMarkers,
  rotateRefusal,
  refuseInheritedEnv,
  runsDir,
  locksDir,
  AccountsError,
} from "./accounts";
import {
  FORBIDDEN_ACCOUNT_IDS,
  tokenGate,
  type CfApi,
  type FetchLike,
} from "./cf";
import type { Docker, DockerInfo } from "./docker";
import {
  acquireAccountLock,
  liveLocks,
  readLastTeardownAt,
  teardownGapRemainingMs,
  LockHeldError,
} from "./lock";
import { containerOwnedByRun } from "./sandbox";
import { capture, spawnProcess, type Spawn } from "./spawn";
import type {
  Account,
  InfraReasonCode,
  Phase,
  ProviderVar,
  RunRecord,
} from "./types";

const DOCS_URL = "https://everyapp.com/llms.txt";
/** Below this, `--parallel` is refused: two 6 GiB containers plus the siblings. */
const PARALLEL_MIN_BYTES = 14 * 1024 ** 3;
/** Below this, a warning: Docker Desktop should go to 16 GiB. */
const MEMORY_WARN_BYTES = 8 * 1024 ** 3;
const MAX_CLOCK_SKEW_S = 60;

type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type WorkersPlan = "paid" | "free" | "unknown";

export interface PreflightResult {
  ok: boolean;
  reasonCode: InfraReasonCode | null;
  checks: PreflightCheck[];
  docker: DockerInfo | null;
  /** `lsof` LISTEN lines; the ones bound on every interface are reachable from a container. */
  listeners: { all: string[]; allInterfaces: string[] };
  fixtures: {
    workers_subdomain: RunRecord["fixtures"]["workers_subdomain"];
    docs_url: RunRecord["fixtures"]["docs_url"];
    plan: WorkersPlan;
    subscriptions: unknown[];
    zoneId: string | null;
  };
  /** The sleep through the 30-minute wipe gap, as a phase for the record (`durationS` leaves it out). */
  gapWait: Phase | null;
  /** Releases the account lock; a no-op when none was taken. */
  release: () => void;
}

export interface PreflightOptions {
  account: Account;
  runId: string;
  /** No network: the token, zone, plan, subdomain and docs checks are skipped with a reason. */
  dryRun: boolean;
  parallel?: number;
  image: string;
  configDir: string;
  docker: Pick<
    Docker,
    | "info"
    | "listContainers"
    | "removeContainers"
    | "imageExists"
    | "clockSkewSeconds"
  > | null;
  cf: CfApi | null;
  /** The provider key this run hands the harness, checked against the rotate markers. */
  provider?: { name: ProviderVar; value: string } | null;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  spawn?: Spawn;
  now?: () => number;
  /** Take the account lock (default true); false for a check that must not block a running lane. */
  lock?: boolean;
  /**
   * Sleep through the 30-minute gap after the account's last wipe instead of
   * refusing (the lock is held meanwhile). Absent: refuse, as `--no-wait` and
   * `--dry-run` do.
   */
  waitForGap?: {
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
  };
}

/** The lines of `lsof -nP -iTCP -sTCP:LISTEN`, or [] when lsof is absent. */
async function listListeners(spawn: Spawn): Promise<string[]> {
  try {
    const out = await capture(spawn, "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    return out.stdout.slice(1);
  } catch {
    return [];
  }
}

/** A listener on `*:port` or `0.0.0.0:port` or `[::]:port` is reachable from a container through host.docker.internal. */
export const isAllInterfaces = (line: string): boolean =>
  /\s(\*|0\.0\.0\.0|\[::\]):\d+\s/.test(`${line} `);

const ENDED = /cancel|expired|failed/i;

/** The plan from the subscription rows, the way packages/cli's plan.ts reads them. */
export function workersPlanOf(rows: unknown[]): WorkersPlan {
  for (const raw of rows) {
    const row = (raw ?? {}) as {
      state?: string | null;
      rate_plan?: { id?: string | null; public_name?: string | null } | null;
      product?: { name?: string | null } | null;
    };
    if (ENDED.test(row.state ?? "")) continue;
    const names = [
      row.rate_plan?.id,
      row.rate_plan?.public_name,
      row.product?.name,
    ].filter((n): n is string => !!n);
    if (!names.some((name) => /workers/i.test(name))) continue;
    if (names.some((name) => /paid|standard/i.test(name))) return "paid";
    if (names.some((name) => /free/i.test(name))) return "free";
  }
  return "unknown";
}

export async function runPreflight(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnProcess;
  const now = options.now ?? (() => Date.now());
  const checks: PreflightCheck[] = [];
  let release: () => void = () => undefined;
  let gapWait: Phase | null = null;
  let dockerInfo: DockerInfo | null = null;
  const listeners = { all: [] as string[], allInterfaces: [] as string[] };
  const fixtures: PreflightResult["fixtures"] = {
    workers_subdomain: "unknown",
    docs_url: { status: null, final_url: null },
    plan: "unknown",
    subscriptions: [],
    zoneId: null,
  };
  const result = (
    ok: boolean,
    reasonCode: InfraReasonCode | null,
  ): PreflightResult => ({
    ok,
    reasonCode,
    checks,
    docker: dockerInfo,
    listeners,
    fixtures,
    gapWait,
    release,
  });
  const check = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };
  const fail = (
    name: string,
    detail: string,
    reasonCode: InfraReasonCode = "preflight_failed",
  ): PreflightResult => {
    check(name, "fail", detail);
    release();
    release = () => undefined;
    return result(false, reasonCode);
  };
  const skip = (name: string, why: string): void => check(name, "skip", why);

  // 1. The driver's own environment.
  try {
    refuseInheritedEnv(env);
    check(
      "env",
      "ok",
      "no inherited EVERYAPP_TEST_ACCOUNTS, CLOUDFLARE_API_TOKEN or EVERYAPP_GATEWAY_URL",
    );
  } catch (error) {
    return fail("env", (error as AccountsError).message);
  }

  // 2. The account's id: 32 hex, and never the forbidden one (the file loader refuses it too; a caller
  // that builds an Account by hand, or a dry run with no token gate, is refused here all the same).
  const { account } = options;
  if (!/^[0-9a-f]{32}$/.test(account.accountId))
    return fail("account", `"${account.name}" has no 32-hex account id.`);
  if (FORBIDDEN_ACCOUNT_IDS.includes(account.accountId))
    return fail(
      "account",
      `${account.name} is a forbidden account: the loop never touches it.`,
      "whoami_gate_failed",
    );
  check("account", "ok", `${account.name}: zone ${account.zone}`);

  // 3. Rotate markers: a value an earlier run saw echoed is refused until it hashes differently.
  const markers = readRotateMarkers(runsDir(options.configDir));
  const tokenMarker = rotateRefusal(
    markers.filter((m) => m.name === "cf_token"),
    account.token,
  );
  if (tokenMarker) {
    return fail(
      "rotate",
      `ROTATE: the Cloudflare token of ${account.name} was echoed in run ${tokenMarker.runId}; roll it and edit accounts.json.`,
    );
  }
  if (options.provider) {
    const providerMarker = rotateRefusal(
      markers.filter((m) => m.name === "provider_key"),
      options.provider.value,
    );
    if (providerMarker) {
      return fail(
        "rotate",
        `ROTATE: ${options.provider.name} was echoed in run ${providerMarker.runId}; roll it and edit providers.env.`,
      );
    }
  }
  check(
    "rotate",
    "ok",
    `${markers.length} rotate marker(s) read, none matches`,
  );

  // 4. The lock, O_EXCL, per account.
  if (options.lock ?? true) {
    try {
      const lock = acquireAccountLock(
        locksDir(options.configDir),
        account.accountId,
        options.runId,
        { now: now() },
      );
      release = lock.release;
      check("lock", "ok", `locked ${account.name} for ${options.runId}`);
    } catch (error) {
      if (error instanceof LockHeldError) return fail("lock", error.message);
      throw error;
    }
  } else {
    skip("lock", "not taken (lock: false)");
  }

  // 5. The 30-minute gap since the last teardown (Cloudflare's SOA negative TTL is 1800 s).
  const lastWipe = readLastTeardownAt(
    locksDir(options.configDir),
    account.accountId,
  );
  const remaining = teardownGapRemainingMs(lastWipe, now());
  if (remaining > 0 && options.waitForGap) {
    const minutes = Math.ceil(remaining / 60000);
    options.waitForGap.log(
      `wait teardown_gap  ${account.name} was wiped at ${lastWipe}; waiting ${minutes} min for the 30-minute gap (--no-wait refuses instead)`,
    );
    const waitStarted = now();
    await options.waitForGap.sleep(remaining);
    gapWait = {
      name: "preflight.gap_wait",
      startedAt: new Date(waitStarted).toISOString(),
      durationS: Math.round((now() - waitStarted) / 1000),
    };
    check(
      "teardown_gap",
      "ok",
      `waited ${minutes} min for the 30-minute gap after the wipe at ${lastWipe}`,
    );
  } else if (remaining > 0) {
    return fail(
      "teardown_gap",
      `${account.name} was wiped ${Math.ceil(remaining / 60000)} min too recently; wait, or use the other account.`,
      "dns_negative_cache",
    );
  } else {
    check(
      "teardown_gap",
      "ok",
      "30 minutes or more since the last wipe, or never wiped",
    );
  }

  // 6. Docker answers; memory recorded; --parallel needs 14 GiB.
  if (!options.docker) {
    skip("docker", "no docker (resolveDockerBinary found none, or a test)");
  } else {
    try {
      dockerInfo = await options.docker.info();
    } catch (error) {
      return fail("docker", `docker info failed: ${(error as Error).message}`);
    }
    const gib = (dockerInfo.memBytes / 1024 ** 3).toFixed(2);
    const parallel = options.parallel ?? 1;
    if (parallel > 1 && dockerInfo.memBytes < PARALLEL_MIN_BYTES) {
      return fail(
        "docker",
        `--parallel ${parallel} needs 14 GiB of VM memory; Docker has ${gib} GiB.`,
      );
    }
    check(
      "docker",
      dockerInfo.memBytes < MEMORY_WARN_BYTES ? "warn" : "ok",
      `engine ${dockerInfo.engine}, ${dockerInfo.os}/${dockerInfo.arch}, ${dockerInfo.ncpu} CPUs, ${gib} GiB${
        dockerInfo.memBytes < MEMORY_WARN_BYTES
          ? " (raise Docker Desktop's memory to 16 GiB)"
          : ""
      }`,
    );

    // 7. Stale loop-* containers: stopped ones that no run with a live lock owns. A second lane's
    // harness and siblings are running under their own lock and are never touched; a dry run removes nothing.
    if (options.dryRun) {
      skip("stale_containers", "--dry-run: nothing is removed");
    } else {
      const live = liveLocks(locksDir(options.configDir), now()).map(
        (lock) => lock.runId,
      );
      const stopped = await options.docker.listContainers("loop-", "stopped");
      const stale = stopped.filter((name) => !containerOwnedByRun(name, live));
      await options.docker.removeContainers(stale);
      const kept = stopped.length - stale.length;
      check(
        "stale_containers",
        "ok",
        `${stale.length === 0 ? "none" : `removed ${stale.join(", ")}`}${kept > 0 ? `; ${kept} kept (a live run's)` : ""}`,
      );
    }

    // 8. The image exists and its clock agrees with the host's.
    if (await options.docker.imageExists(options.image)) {
      try {
        const skew = await options.docker.clockSkewSeconds(options.image);
        if (Math.abs(skew) > MAX_CLOCK_SKEW_S)
          return fail(
            "clock",
            `the container's clock is ${skew.toFixed(0)} s off the host's.`,
          );
        check(
          "clock",
          "ok",
          `container clock ${skew.toFixed(1)} s from the host's`,
        );
      } catch (error) {
        return fail(
          "clock",
          `could not read the container's clock: ${(error as Error).message}`,
        );
      }
    } else {
      skip(
        "clock",
        `image ${options.image} is not built yet (pnpm loop doctor builds it)`,
      );
    }
  }

  // 9. Listeners a container could reach.
  listeners.all = await listListeners(spawn);
  listeners.allInterfaces = listeners.all.filter(isAllInterfaces);
  check(
    "listeners",
    listeners.allInterfaces.length > 0 ? "warn" : "ok",
    listeners.allInterfaces.length > 0
      ? `${listeners.allInterfaces.length} listener(s) on all interfaces are reachable from the container via host.docker.internal; bind dev servers to 127.0.0.1`
      : `${listeners.all.length} listener(s), none on all interfaces`,
  );

  // 10. The network checks, through cf.ts.
  if (options.dryRun || !options.cf) {
    const why = options.dryRun
      ? "--dry-run: no network call is made"
      : "no Cloudflare API client";
    for (const name of [
      "token",
      "zone",
      "plan",
      "workers_subdomain",
      "docs_url",
    ])
      skip(name, why);
    return result(true, null);
  }
  const cf = options.cf;
  const gate = await tokenGate(cf, account.accountId);
  if (!gate.ok) {
    const code: InfraReasonCode =
      gate.code === "token_rejected"
        ? "fixture_token_rejected"
        : "whoami_gate_failed";
    return fail("token", `${gate.code}: ${gate.detail}`, code);
  }
  check("token", "ok", "active; sees exactly this account; none forbidden");

  const zones = await cf.listZones(account.zone);
  const zone = zones.find(
    (row) => row.name.toLowerCase() === account.zone.toLowerCase(),
  );
  if (!zone)
    return fail(
      "zone",
      `the token sees no zone ${account.zone}`,
      "fixture_add_domain",
    );
  if (zone.status !== "active")
    return fail(
      "zone",
      `zone ${account.zone} is ${zone.status}, not active`,
      "fixture_add_domain",
    );
  fixtures.zoneId = zone.id;
  check("zone", "ok", `${account.zone} active`);

  try {
    fixtures.subscriptions = await cf.subscriptions();
    fixtures.plan = workersPlanOf(fixtures.subscriptions);
    check(
      "plan",
      fixtures.plan === "paid" ? "ok" : "warn",
      `Workers plan ${fixtures.plan}${fixtures.plan === "free" ? " (setup must stop on upgrade_workers_paid)" : ""}`,
    );
  } catch (error) {
    check(
      "plan",
      "warn",
      `subscriptions unreadable: ${(error as Error).message}`,
    );
  }

  try {
    const subdomain = await cf.getWorkersSubdomain();
    fixtures.workers_subdomain = subdomain ? "preexisting" : "first-run";
    check(
      "workers_subdomain",
      "ok",
      subdomain
        ? "set"
        : "none yet: the first Worker may stop on register_workers_subdomain",
    );
  } catch (error) {
    check(
      "workers_subdomain",
      "warn",
      `unreadable: ${(error as Error).message}`,
    );
  }

  try {
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    const response = await fetchImpl(DOCS_URL, {
      method: "GET",
      redirect: "manual",
    });
    fixtures.docs_url = {
      status: response.status,
      final_url: response.headers.get("location") ?? DOCS_URL,
    };
    check(
      "docs_url",
      response.status === 200 ? "ok" : "warn",
      `${DOCS_URL} answered ${response.status}`,
    );
  } catch (error) {
    fixtures.docs_url = { status: null, final_url: null };
    check(
      "docs_url",
      "warn",
      `${DOCS_URL} unreachable: ${(error as Error).message}`,
    );
  }

  return result(true, null);
}

/** One line per check, for the terminal. */
export function formatChecks(checks: PreflightCheck[]): string[] {
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks.map(
    (check) =>
      `${check.status.padEnd(4)} ${check.name.padEnd(width)}  ${check.detail}`,
  );
}
