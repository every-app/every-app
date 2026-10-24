/**
 * `everyapp create [name]`: a new app from the starter template, ready
 * for `everyapp dev`, without contacting the Gateway.
 *
 * 1. Copy `starter/` from this checkout: to apps/<name> inside
 *    the checkout, or ./<name> anywhere else (lib/app/starter.ts), named
 *    after the app in package.json, everyapp.config.ts and README.md.
 * 2. Put the everyapp skill where coding agents look (lib/app/skill.ts).
 * 3. Install its dependencies; when that fails, the app is there and only
 *    the install is left, so the error says to finish it in place.
 * 4. Generate the Worker's types and apply its migrations to the local
 *    database (both redone by `everyapp dev`: a failure is a warning).
 * 5. Outside the checkout, start a git repository for it (a failure is a
 *    warning: the app is complete without it).
 *
 * Each step is a `create.*` step event with a start and a time.
 */
import path from "node:path";
import { applyLocalMigrations } from "@/lib/app/localD1";
import { linkSkill } from "@/lib/app/skill";
import { copyStarter, newAppDir } from "@/lib/app/starter";
import { generateWorkerTypes } from "@/lib/app/workerTypes";
import { checkoutRoot, isInCheckout } from "@/lib/checkout";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { directoryExists, fileExists } from "@/lib/file-operations";
import { initRepository } from "@/lib/git";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { strings, text } from "@/lib/output/text";
import { installDependencies } from "@/lib/package-manager";
import { resolveAppId } from "./steps/appId";

interface CreateCommandFlags {
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export default async function create(flags: CreateCommandFlags,
  appIdArg?: string,
): Promise<void> {
  await runCommand(flags, (out) => createApp({ flags, appIdArg, out }));
}

interface CreateAppOptions {
  flags: CreateCommandFlags;
  appIdArg?: string;
  out: EventSink;
  cwd?: string;
  /** The checkout the template comes from (tests). */
  root?: string;
  cf?: CfRunner;
  /** Seams for tests. */
  install?: typeof installDependencies;
  git?: typeof initRepository;
}

export async function createApp({
  flags,
  appIdArg,
  out,
  cwd = process.cwd(),
  root = checkoutRoot(),
  cf = createCfRunner(),
  install = installDependencies,
  git = initRepository,
}: CreateAppOptions): Promise<void> {
  const verbose = flags.verbose ?? false;

  if (await fileExists(path.join(cwd, "everyapp.config.ts"))) {
    throw new EveryAppError(
      "NESTED_APP",
      "This directory is already an app\nIt has an everyapp.config.ts. New apps go next to it, not inside it.",
      { fix: "run create from the directory that holds your apps" },
    );
  }
  // Questions only for a person at the terminal, never under --yes or --json.
  const appId = await resolveAppId(appIdArg, {
    interactive: !flags.yes && canPromptInTerminal(flags.json ?? false),
    yes: flags.yes ?? false,
  });
  const targetDir = newAppDir({ appId, cwd, root });
  // `cd` takes it as is; messages say ./ for a directory under this one.
  const relative = path.relative(cwd, targetDir);
  const shown = relative.startsWith("..") ? relative : `./${relative}`;
  if (await directoryExists(targetDir)) {
    throw new EveryAppError("APP_DIR_EXISTS", `${shown} already exists`, {
      fix: `pick another name, or move ${shown} away`,
    });
  }

  out.emit({
    type: "step",
    step: "create.copy",
    status: "start",
    message: "Copying the starter template",
    // Run in the checkout away from its root, the app isn't where they are.
    data: { appId, shown, elsewhere: relative.startsWith("..") },
  });
  await copyStarter({ root, targetDir, appId });
  out.emit({
    type: "step",
    step: "create.copy",
    status: "ok",
    message: "Copied the starter template",
    data: { appId, dir: targetDir },
  });
  const skill = await linkSkill({ root, appDir: targetDir });
  out.emit({
    type: "step",
    step: "create.skill",
    status: "ok",
    message: "Added the everyapp skill for coding agents",
    data: skill,
  });

  await timed(out, "create.install", ["Installing dependencies", "Installed dependencies"], async () => {
    try {
      await install({ cwd: targetDir, description: "Installing dependencies", verbose });
    } catch (error) {
      throw installFailed(error, { shown, relative });
    }
  });

  const manifest = await loadEveryAppManifest(targetDir);
  try {
    await timed(out, "create.types", ["Generating types", "Generated types"], () =>
      generateWorkerTypes(cf, targetDir),
    );
  } catch (error) {
    out.emit({
      type: "warning",
      code: "WORKER_TYPES_FAILED",
      step: "create.types",
      message: `Couldn't generate types\n${firstLine(error)}. pnpm dev tries again.`,
    });
  }
  try {
    out.emit({
      type: "step",
      step: "migrations.local",
      status: "start",
      message: "Setting up the local database",
    });
    const result = await applyLocalMigrations({ cwd: targetDir, manifest, cf });
    out.emit({
      type: "step",
      step: "migrations.local",
      status: result.status === "applied" ? "ok" : "skip",
      message: "Set up the local database",
      data:
        result.status === "applied"
          ? { database: result.database, applied: result.applied }
          : { reason: result.reason },
    });
  } catch (error) {
    out.emit({ type: "step", step: "migrations.local", status: "fail" });
    out.emit({
      type: "warning",
      code: "MIGRATIONS_FAILED",
      step: "migrations.local",
      message: `Couldn't set up the local database\n${firstLine(error)}. pnpm dev tries again.`,
      data: { rerun: `${CLI} db migrate` },
    });
  }

  // Its own git repository, unless it's part of this checkout's. The app is
  // complete without one: a failure is a warning.
  if (!isInCheckout(targetDir, root)) {
    try {
      await timed(out, "create.git", ["Starting a git repository", "Started a git repository"], () =>
        git({ targetDir, verbose }),
      );
    } catch (error) {
      if (!(error instanceof EveryAppError) || error.code !== "GIT_FAILED") throw error;
      const committing = text(error.data?.["command"])?.startsWith("git commit") ?? false;
      out.emit({
        type: "warning",
        code: "GIT_FAILED",
        step: "create.git",
        message: `${committing ? "Couldn't make the first git commit" : "Couldn't start a git repository"}\ngit: ${strings(error.data?.["tail"]).at(-1) ?? "failed"}. Full log: ${text(error.data?.["log"])}`,
        data: {
          fix: committing
            ? `set git's user.name and user.email, then commit in ${shown}`
            : `start one yourself in ${shown}: git init, then commit`,
        },
      });
    }
  }

  // The app's own scripts, as the docs and its AGENTS.md say them: `pnpm
  // dev` and `pnpm run deploy` work in its directory wherever it was made.
  const next = [
    { command: `cd ${relative}` },
    { command: "pnpm dev", note: "run it locally" },
    { command: "pnpm run deploy", note: "put it live" },
  ];
  out.emit({ type: "done", data: { appId, dir: targetDir, next } });
}

/** A step with a start and an ok, its time (`data.ms`) on the ok. */
async function timed(
  out: EventSink,
  step: string,
  [doing, done]: [string, string],
  work: () => Promise<unknown>,
): Promise<void> {
  const began = Date.now();
  out.emit({ type: "step", step, status: "start", message: doing });
  try {
    await work();
  } catch (error) {
    out.emit({ type: "step", step, status: "fail" });
    throw error;
  }
  out.emit({ type: "step", step, status: "ok", message: done, data: { ms: Date.now() - began } });
}

/** The first line of what went wrong, without its trailing period. */
function firstLine(error: unknown): string {
  return (errorMessage(error).split("\n")[0] ?? "").replace(/\.$/, "");
}

/** How many of a failed child's last lines a create error shows. */
const TAIL_LINES = 5;

/**
 * A failed install, said for a new app: it exists, only the install is
 * left, so the way on is to finish it there, not to create it again.
 */
function installFailed(error: unknown, { shown, relative }: { shown: string; relative: string }): unknown {
  if (!(error instanceof EveryAppError) || error.code !== "INSTALL_FAILED") return error;
  const data = error.data ?? {};
  const tail = strings(data["tail"]).slice(-TAIL_LINES);
  return new EveryAppError(
    "INSTALL_FAILED",
    [
      "Couldn't install dependencies",
      `${text(data["command"])} exited ${String(data["exitCode"])}.${tail.length > 0 ? " Its last lines:" : ""}`,
      ...tail.map((line) => `  ${line}`),
      `Full log: ${text(data["log"])}`,
      `${shown} is created; only the install is left.`,
    ].join("\n"),
    { rerun: `cd ${relative} && pnpm install`, data },
  );
}
