#!/usr/bin/env node
/**
 * pnpm e2e: a sandbox Gateway in this machine's Cloudflare account, to try a
 * change on a real Gateway. The commands are USAGE below; what each does is
 * docs/runbooks/e2e.md.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { baseCheckout, repoRoot } from "./checkout.mjs";
import { readConfig } from "./config.mjs";
import { childEnv } from "./everyapp.mjs";
import { chromium } from "playwright";
import {
  GATEWAY_NAME,
  deployStarter,
  deployStarterAs,
  gatewayHost,
  install,
  newGatewayName,
  setOAuthClients,
  signIn,
  teardown,
  update,
} from "./gateway.mjs";
import { checkHealth } from "./health.mjs";

const Command = Object.freeze({
  Up: "up",
  Update: "update",
  App: "app",
  Open: "open",
  Exec: "exec",
  List: "list",
  Down: "down",
});

const USAGE = [
  "Usage: pnpm e2e up [--from <ref>] [--name <name>]",
  "       pnpm e2e update <name>",
  "       pnpm e2e app <name> <app-id> [--provider <id> --scopes <a,b>]",
  "       pnpm e2e open <name> [<path>]",
  "       pnpm e2e exec <name> -- <command>",
  "       pnpm e2e list",
  "       pnpm e2e down <name>",
].join("\n");

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    name: { type: "string" },
    provider: { type: "string" },
    scopes: { type: "string" },
  },
});
const [command, name, ...rest] = positionals;
if (!Object.values(Command).includes(command)) {
  console.error(USAGE);
  process.exit(2);
}

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const repo = repoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** A sandbox's folder: its state (sandbox.json, mode 600: the owner's password) and its commands' logs. */
const sandboxDir = (sandboxName) => path.join(config.stateDir, sandboxName);

/** A sandbox this machine brought up, or a usage error. */
function readSandbox(sandboxName) {
  if (!sandboxName) {
    console.error(USAGE);
    process.exit(2);
  }
  const file = path.join(sandboxDir(sandboxName), "sandbox.json");
  if (!fs.existsSync(file)) {
    console.error(`No sandbox ${sandboxName} on this machine (pnpm e2e list).`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSandbox(sandbox) {
  fs.writeFileSync(path.join(sandbox.dir, "sandbox.json"), `${JSON.stringify(sandbox, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function up() {
  if (flags.name !== undefined && !GATEWAY_NAME.test(flags.name)) {
    console.error("--name takes 1 to 16 lowercase letters or digits.");
    process.exit(2);
  }
  const sandbox = { name: flags.name ?? newGatewayName(), dir: "" };
  sandbox.dir = sandboxDir(sandbox.name);
  if (fs.existsSync(path.join(sandbox.dir, "sandbox.json"))) {
    console.error(`Sandbox ${sandbox.name} is up already (pnpm e2e list).`);
    process.exit(2);
  }
  fs.mkdirSync(sandbox.dir, { recursive: true });
  const checkout = flags.from ? baseCheckout({ repo, ref: flags.from }) : repo;
  console.log(
    `Sandbox ${sandbox.name} at https://${gatewayHost(config, sandbox.name)}, from ${flags.from ?? "this checkout"}\n`,
  );
  try {
    const gateway = await install({ config, checkout, sandbox });
    Object.assign(sandbox, {
      url: gateway.url,
      owner: gateway.owner,
      from: flags.from ?? null,
      checkout,
      createdAt: new Date().toISOString(),
    });
    writeSandbox(sandbox);
    const clients = await setOAuthClients({ config, checkout, sandbox });
    if (clients.length > 0) console.log(`  ✓ Set the saved OAuth clients for ${sandbox.name}: ${clients.join(", ")}`);
    await deployStarter({ config, checkout, sandbox });
    await checkHealth({ config, checkout, sandbox, label: "up" });
  } catch (error) {
    console.error(`\n${error.message}\nIt's still up: pnpm e2e down ${sandbox.name}`);
    process.exit(1);
  }
  console.log(
    `\nUp: ${sandbox.url}\nOwner sign-in: ${path.join(sandbox.dir, "sandbox.json")}\n` +
      `Next: pnpm e2e ${flags.from ? `update ${sandbox.name}` : `exec ${sandbox.name} -- <command>`}, then pnpm e2e down ${sandbox.name}`,
  );
}

async function updateSandbox() {
  const sandbox = readSandbox(name);
  await update({ config, checkout: repo, sandbox });
  sandbox.checkout = repo;
  writeSandbox(sandbox);
  await checkHealth({ config, checkout: repo, sandbox, label: "update" });
}

/** Deploy the starter as `rest[0]`, listing --provider with --scopes, with the sandbox's current checkout. */
async function app() {
  const sandbox = readSandbox(name);
  const [appId] = rest;
  const scopes = (flags.scopes ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  if (!appId || !APP_ID.test(appId) || (scopes.length > 0 && !flags.provider)) {
    console.error(USAGE);
    process.exit(2);
  }
  await deployStarterAs({
    config,
    checkout: sandbox.checkout,
    sandbox,
    appId,
    provider: flags.provider ?? null,
    scopes,
  });
  console.log(`Deployed ${appId} to ${sandbox.name}`);
}

/**
 * A visible browser signed in as the owner, at `rest[0]` (default /), until
 * the person closes it. Its profile is kept in the state folder, so a sign-in
 * at a provider carries over to the next run.
 */
async function open() {
  const sandbox = readSandbox(name);
  const profile = path.join(config.stateDir, "browser-profile");
  const context = await chromium
    .launchPersistentContext(profile, { headless: false, viewport: null })
    .catch((error) => {
      if (/existing browser session|in use/i.test(error.message)) {
        throw new Error("A window from pnpm e2e open is still open (its profile is in use): close it, then run this again.");
      }
      throw error;
    });
  const page = await signIn(context, sandbox);
  await page.goto(new URL(rest[0] ?? "/", sandbox.url).href);
  console.log(`Opened ${page.url()} as ${sandbox.owner.email}. Close the browser when done.`);
  await new Promise((resolve) => context.on("close", resolve));
}

/** Run `rest` with the account's token, and everyapp aimed at the sandbox. */
function exec() {
  const sandbox = readSandbox(name);
  if (rest.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const result = spawnSync(rest[0], rest.slice(1), {
    stdio: "inherit",
    env: { ...childEnv(config), EVERYAPP_GATEWAY_URL: sandbox.url },
  });
  process.exit(result.status ?? 1);
}

function list() {
  const names = fs.existsSync(config.stateDir) ? fs.readdirSync(config.stateDir) : [];
  const sandboxes = names
    .filter((entry) => fs.existsSync(path.join(sandboxDir(entry), "sandbox.json")))
    .map(readSandbox);
  if (sandboxes.length === 0) console.log("No sandboxes up.");
  for (const sandbox of sandboxes) {
    console.log(`${sandbox.name}  ${sandbox.url}  from ${sandbox.from ?? "a checkout"}  since ${sandbox.createdAt}`);
  }
}

async function down() {
  const sandbox = readSandbox(name);
  await teardown({ config, checkout: repo, sandbox });
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
  console.log(`Tore down ${sandbox.name}`);
}

const run = { up, update: updateSandbox, app, open, exec, list, down };
try {
  await run[command]();
} catch (error) {
  console.error(`\n${error.message}`);
  if (name && command !== Command.Down) console.error(`The sandbox is still up: pnpm e2e down ${name}`);
  process.exit(1);
}
