/**
 * `everyapp app create [app-id]`: a new app from the starter template, ready
 * for `everyapp dev`, without contacting the Gateway.
 *
 * 1. Copy `templates/simple-todo` from this checkout: to apps/<id> inside the
 *    checkout, or ./<id> anywhere else (lib/app/starter.ts), named after the
 *    app in package.json and everyapp.config.ts.
 * 2. Install its dependencies.
 * 3. Generate the Worker's types and apply its migrations to the local
 *    database (both are redone by `everyapp dev` if they fail here).
 * 4. Outside the checkout, start a git repository for it.
 * 5. With --deploy, deploy it as `everyapp app deploy` does.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { applyLocalMigrations } from "@/lib/app/localD1";
import { copyStarter, newAppDir } from "@/lib/app/starter";
import { generateWorkerTypes } from "@/lib/app/workerTypes";
import { checkoutRoot, isInCheckout } from "@/lib/checkout";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { directoryExists } from "@/lib/file-operations";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";
import { initRepository } from "@/lib/git";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { installDependencies } from "@/lib/package-manager";
import { resolveAppId } from "./steps/appId";

interface CreateCommandFlags {
  deploy?: boolean;
  gateway?: string;
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

export default async function create(
  this: LocalContext,
  flags: CreateCommandFlags,
  appIdArg?: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, () => createApp({ flags, appIdArg, out }), {
    verbose: flags.verbose,
  });
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
  deploy?: typeof deployApp;
}

export async function createApp({
  flags,
  appIdArg,
  out,
  cwd = process.cwd(),
  root = checkoutRoot(),
  cf = createCfRunner(),
  install = installDependencies,
  deploy = deployApp,
}: CreateAppOptions): Promise<void> {
  const verbose = flags.verbose ?? false;

  if (await fileExists(path.join(cwd, "everyapp.config.ts"))) {
    throw new EveryAppError(
      "NESTED_APP",
      "This directory is an app already (it has everyapp.config.ts). Run create from the directory that holds your apps; to deploy this one: pnpm everyapp app deploy",
    );
  }
  const appId = await resolveAppId(appIdArg, {
    interactive: !flags.yes && canPromptInTerminal(flags.json ?? false),
  });
  const targetDir = newAppDir({ appId, cwd, root });
  const relative = path.relative(cwd, targetDir);
  const shown = relative.startsWith("..") ? relative : `./${relative}`;
  if (await directoryExists(targetDir)) {
    throw new EveryAppError(
      "APP_DIR_EXISTS",
      `${targetDir} already exists; pick another app id or move it away.`,
    );
  }

  out.emit({
    type: "step",
    step: "create.copy",
    status: "start",
    message: `Creating ${appId} in ${shown}...`,
  });
  await copyStarter({ root, targetDir, appId });
  out.emit({
    type: "step",
    step: "create.copy",
    status: "ok",
    data: { appId, dir: targetDir },
  });

  await install({
    cwd: targetDir,
    description: "Installing dependencies...",
    verbose,
  });
  out.emit({ type: "step", step: "create.install", status: "ok" });

  const manifest = await loadEveryAppManifest(targetDir);
  try {
    await generateWorkerTypes(cf, targetDir);
    out.emit({ type: "step", step: "create.types", status: "ok" });
  } catch (error) {
    out.emit({
      type: "warning",
      code: "WORKER_TYPES_FAILED",
      step: "create.types",
      message: `Couldn't generate the Worker's types (${errorMessage(error)}); \`pnpm dev\` tries again.`,
    });
  }
  try {
    const result = await applyLocalMigrations({
      cwd: targetDir,
      manifest,
      cf,
    });
    out.emit({
      type: "step",
      step: "migrations.local",
      status: result.status === "applied" ? "ok" : "skip",
      data:
        result.status === "applied"
          ? { database: result.database, applied: result.applied }
          : { reason: result.reason },
    });
  } catch (error) {
    out.emit({
      type: "warning",
      code: "MIGRATIONS_FAILED",
      step: "migrations.local",
      message: `Couldn't set up the local database (${errorMessage(error)}); \`pnpm dev\` tries again, or run: pnpm run db:migrate:local`,
    });
  }

  // Its own git repository, unless it's part of this checkout's.
  if (!isInCheckout(targetDir, root)) {
    await initRepository({ targetDir, verbose });
    out.emit({ type: "step", step: "create.git", status: "ok" });
  }

  const next = [`cd ${shown}`, "pnpm dev"];
  if (!flags.deploy) {
    out.emit({
      type: "done",
      message: `Created ${appId} in ${shown}.\nNext: ${next.join(" && ")}`,
      data: { appId, dir: targetDir, next },
    });
    return;
  }

  out.emit({
    type: "step",
    step: "create.deploy",
    status: "start",
    message: `Created ${appId} in ${shown}; deploying it...`,
  });
  const deployed = await deploy({
    cwd: targetDir,
    manifest,
    gatewayUrl: await resolveGatewayUrl(flags.gateway),
    out,
    json: flags.json,
    verbose,
  });
  out.emit({
    type: "done",
    message: `${appId} is live at ${deployed.liveUrl}\nNext: ${next.join(" && ")}`,
    data: { appId, dir: targetDir, url: deployed.liveUrl, next },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
