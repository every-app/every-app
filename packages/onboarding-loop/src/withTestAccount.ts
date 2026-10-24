/**
 * The one helper every token-bearing `everyapp` (and so `cf`) subprocess
 * goes through (design 4.1, 5, 4.14): a sibling container from the same
 * image, with exactly CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its
 * environment, plus EVERYAPP_TEST_ACCOUNTS=<accountId> when the child is
 * the teardown, through a 600 env file deleted the moment the container
 * exists. A Linux container has no macOS Keychain, so Ben's own `cf` login
 * is structurally unreachable from it. The token gate (cf.ts) runs first,
 * from the host, before anything is created. The checkout inside is a
 * pristine clone of the commit under test from a git bundle (4.6): never
 * the harness's tree.
 */
import { randomUUID } from "node:crypto";
import { tokenGate, type CfApi, type TokenGate } from "./cf";
import {
  execCapture,
  siblingContainerPrefix,
  type ExecCapture,
} from "./sandbox";
import { capture, type Spawn } from "./spawn";
import type {
  Account,
  ExecLine,
  ExecOptions,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
} from "./types";

/** Where the bundle lands and where it is cloned, inside every container. */
export const BUNDLE_PATH = "/loop/launch.bundle";
export const CHECKOUT_PATH = "/work/every-app";

export class TokenGateError extends Error {
  constructor(readonly gate: Exclude<TokenGate, { ok: true }>) {
    super(`Token gate refused the account: ${gate.code}: ${gate.detail}`);
    this.name = "TokenGateError";
  }
}

export class SiblingError extends Error {
  constructor(
    message: string,
    readonly output: ExecCapture,
  ) {
    super(message);
    this.name = "SiblingError";
  }
}

interface SiblingOptions {
  sandbox: Sandbox;
  image: string;
  platform?: SandboxSpec["platform"];
  account: Account;
  runId: string;
  /** The child is the teardown: it gets EVERYAPP_TEST_ACCOUNTS=<accountId> too. */
  allowlist?: boolean;
  /** The bundle to clone to /work/every-app and install; null when the command needs no checkout. */
  bundlePath: string | null;
  /** How the checkout is installed; `pnpm install` at the root, as the prompt says. */
  installArgv?: string[];
  /** The gate before anything runs; null skips it (--dry-run, or a caller that just ran it). */
  cf: CfApi | null;
  /** Every line of every exec, redacted by the sandbox, for the run directory. */
  onLine?: (line: ExecLine) => void;
  /** Extra non-secret variables (EVERYAPP_EVENT_LOG for a sibling whose events are wanted). */
  extraEnv?: Record<string, string>;
  /** The sibling exists; the driver notes it so a cleanup that interrupts `fn` can remove it. */
  onCreated?: (handle: SandboxHandle) => void;
  /** The sibling is gone (the finally ran), whichever way `fn` ended. */
  onDestroyed?: (handle: SandboxHandle) => void;
  /**
   * The driver was stopped: a sibling whose `create` was in flight when
   * the signal landed is destroyed the moment it exists, before any clone,
   * and `fn` never runs. Without it a container created after the cleanup
   * pass looked would outlive the driver.
   */
  signal?: AbortSignal;
}

export interface Sibling {
  handle: SandboxHandle;
  checkout: string | null;
  exec(
    argv: string[],
    options?: Omit<ExecOptions, "onLine">,
  ): Promise<ExecCapture>;
  /** `pnpm everyapp <args>` in the checkout. */
  everyapp(
    args: string[],
    options?: Omit<ExecOptions, "onLine" | "cwd">,
  ): Promise<ExecCapture>;
}

/** Exactly what the child sees. */
export function siblingEnv(
  account: Account,
  allowlist: boolean,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    CLOUDFLARE_API_TOKEN: account.token,
    CLOUDFLARE_ACCOUNT_ID: account.accountId,
    ...(allowlist ? { EVERYAPP_TEST_ACCOUNTS: account.accountId } : {}),
  };
}

/** `git bundle create` of the ref on the host: no push, no credentials. Returns the commit it holds. */
export async function createBundle(
  spawn: Spawn,
  repoDir: string,
  ref: string,
  outPath: string,
): Promise<{ commit: string }> {
  const revision = await capture(
    spawn,
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd: repoDir },
  );
  if (revision.code !== 0)
    throw new Error(`git rev-parse ${ref}: ${revision.stderr.join(" ")}`);
  const commit = revision.stdout[0]!;
  const bundle = await capture(
    spawn,
    "git",
    ["bundle", "create", outPath, ref],
    { cwd: repoDir },
  );
  if (bundle.code !== 0)
    throw new Error(`git bundle create: ${bundle.stderr.join(" ")}`);
  return { commit };
}

/**
 * Gate, create, clone, install, run `fn`, destroy (in a finally). The
 * secrets go in through the Sandbox's env file; `fn` gets exec helpers
 * whose output is already redacted.
 */
export async function withTestAccount<T>(
  options: SiblingOptions,
  fn: (sibling: Sibling) => Promise<T>,
): Promise<T> {
  if (options.cf) {
    const gate = await tokenGate(options.cf, options.account.accountId);
    if (!gate.ok) throw new TokenGateError(gate);
  }
  const name = `${siblingContainerPrefix(options.runId)}${randomUUID().slice(0, 4)}`;
  const spec: SandboxSpec = {
    name,
    image: options.image,
    platform: options.platform ?? "linux/arm64",
    cpus: 2,
    memory: "3g",
    env: siblingEnv(
      options.account,
      options.allowlist ?? false,
      options.extraEnv,
    ),
    user: "dev",
    workdir: "/work",
  };
  const handle = await options.sandbox.create(spec);
  options.onCreated?.(handle);
  if (options.signal?.aborted) {
    await options.sandbox.destroy(handle).catch(() => undefined);
    options.onDestroyed?.(handle);
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("the driver was stopped while the sibling was created");
  }
  const onLine = options.onLine;
  const exec = (
    argv: string[],
    execOptions: Omit<ExecOptions, "onLine"> = {},
  ) =>
    onLine
      ? (async (): Promise<ExecCapture> => {
          const stdout: string[] = [];
          const stderr: string[] = [];
          const result = await options.sandbox.exec(handle, argv, {
            ...execOptions,
            onLine: (line) => {
              (line.stream === "stdout" ? stdout : stderr).push(line.line);
              onLine(line);
            },
          });
          return { result, stdout, stderr };
        })()
      : execCapture(options.sandbox, handle, argv, execOptions);

  try {
    let checkout: string | null = null;
    if (options.bundlePath) {
      await options.sandbox.copyIn(handle, options.bundlePath, BUNDLE_PATH);
      const clone = await exec([
        "git",
        "clone",
        "-q",
        BUNDLE_PATH,
        CHECKOUT_PATH,
      ]);
      if (clone.result.exitCode !== 0)
        throw new SiblingError(
          "git clone of the bundle failed in the sibling",
          clone,
        );
      const install = await exec(options.installArgv ?? ["pnpm", "install"], {
        cwd: CHECKOUT_PATH,
      });
      if (install.result.exitCode !== 0)
        throw new SiblingError("pnpm install failed in the sibling", install);
      checkout = CHECKOUT_PATH;
    }
    const sibling: Sibling = {
      handle,
      checkout,
      exec,
      everyapp: async (args, execOptions = {}) => {
        if (!checkout)
          throw new Error(
            "This sibling has no checkout; it was created with bundlePath: null.",
          );
        return exec(["pnpm", "everyapp", ...args], {
          ...execOptions,
          cwd: checkout,
        });
      },
    };
    return await fn(sibling);
  } finally {
    await options.sandbox.destroy(handle).catch(() => undefined);
    options.onDestroyed?.(handle);
  }
}
