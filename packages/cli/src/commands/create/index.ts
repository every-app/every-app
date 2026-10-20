/**
 * `everyapp create [app-id]`: a new app from the starter template, ready
 * for `everyapp dev`, without contacting the Gateway.
 *
 * 1. Copy `templates/simple-todo` from this checkout: to apps/<id> inside the
 *    checkout, or ./<id> anywhere else (lib/app/starter.ts), named after the
 *    app in package.json and everyapp.config.ts.
 * 2. Put the everyapp skill where coding agents look (lib/app/skill.ts).
 * 3. Install its dependencies.
 * 4. Generate the Worker's types and apply its migrations to the local
 *    database (both are redone by `everyapp dev` if they fail here).
 * 5. Outside the checkout, start a git repository for it.
 * 6. With --deploy, deploy it as `everyapp deploy` does.
 */
import path from "node:path";
import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/deploy/deployApp";
import { applyLocalMigrations } from "@/lib/app/localD1";
import { linkSkill } from "@/lib/app/skill";
import { copyStarter, newAppDir } from "@/lib/app/starter";
import { generateWorkerTypes } from "@/lib/app/workerTypes";
import { checkoutRoot, isInCheckout } from "@/lib/checkout";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { directoryExists, fileExists } from "@/lib/file-operations";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { initRepository } from "@/lib/git";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmAtTerminal, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { CLI } from "@/lib/output/command";
import { installDependencies } from "@/lib/package-manager";
import type { GatewayCommandFlags } from "../flags";
import { resolveAppId } from "./steps/appId";

interface CreateCommandFlags extends GatewayCommandFlags {
  deploy?: boolean;
  yes?: boolean;
}

export default async function create(
  this: LocalContext,
  flags: CreateCommandFlags,
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
  deploy?: typeof deployApp;
  /** Asks the person at the terminal (tests answer for them). */
  confirm?: Confirm;
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
  confirm = confirmAtTerminal,
}: CreateAppOptions): Promise<void> {
  const verbose = flags.verbose ?? false;

  if (await fileExists(path.join(cwd, "everyapp.config.ts"))) {
    throw new EveryAppError(
      "NESTED_APP",
      `This directory is an app already (it has everyapp.config.ts). Run create from the directory that holds your apps; to deploy this one: ${CLI} deploy`,
      { rerun: `${CLI} deploy` },
    );
  }
  // Questions only for a person at the terminal, never under --yes or --json.
  const mayAsk = !flags.yes && canPromptInTerminal(flags.json ?? false);
  const appId = await resolveAppId(appIdArg, { interactive: mayAsk });
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
    data: { appId, shown },
  });
  await copyStarter({ root, targetDir, appId });
  out.emit({
    type: "step",
    step: "create.copy",
    status: "ok",
    data: { appId, dir: targetDir },
  });
  const skill = await linkSkill({
    root,
    appDir: targetDir,
    ask: mayAsk ? confirm : undefined,
  });
  out.emit({
    type: "step",
    step: "create.skill",
    status: "ok",
    message: `Put the everyapp skill in ${skill.paths.join(" and ")}.`,
    data: skill,
  });

  out.emit({ type: "step", step: "create.install", status: "start", message: "Installing dependencies..." });
  await install({
    cwd: targetDir,
    description: "Installing dependencies...",
    verbose,
  });
  out.emit({ type: "step", step: "create.install", status: "ok" });

  const manifest = await loadEveryAppManifest(targetDir);
  try {
    out.emit({ type: "step", step: "create.types", status: "start", message: "Generating types..." });
    await generateWorkerTypes(cf, targetDir);
    out.emit({ type: "step", step: "create.types", status: "ok" });
  } catch (error) {
    out.emit({ type: "step", step: "create.types", status: "fail" });
    out.emit({
      type: "warning",
      code: "WORKER_TYPES_FAILED",
      step: "create.types",
      message: `Couldn't generate the Worker's types (${errorMessage(error)}); \`pnpm dev\` tries again.`,
    });
  }
  try {
    out.emit({ type: "step", step: "migrations.local", status: "start", message: "Setting up the local database..." });
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
    out.emit({ type: "step", step: "migrations.local", status: "fail" });
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

  const next = [
    { command: `cd ${shown}` },
    { command: "pnpm dev", note: "run it locally" },
    ...(flags.deploy ? [] : [{ command: `${CLI} deploy`, note: "put it live" }]),
  ];
  if (!flags.deploy) {
    out.emit({
      type: "done",
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
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    out,
    json: flags.json,
    verbose,
    offerInstall: { yes: flags.yes },
  });
  // `app.live` showed its URL.
  out.emit({
    type: "done",
    data: { appId, dir: targetDir, url: deployed.liveUrl, next },
  });
}
