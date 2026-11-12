/**
 * A sandbox's Gateway: a named Gateway (`setup --name`), so it sits beside
 * anything else in the account and its teardown touches nothing but its own
 * resources. Installed, filled, updated, checked and torn down through the
 * CLI, as a person would; only the owner's claim is done here, over HTTP,
 * the moment setup shows its one-time link.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { everyapp } from "./everyapp.mjs";

/** The starter app's directory in a checkout, and its id. */
const STARTER_DIR = "starter";
export const STARTER_APP_ID = "simple-todo-template";

/** What `setup --name` takes: 1 to 16 lowercase letters or digits. */
export const GATEWAY_NAME = /^[a-z0-9]{1,16}$/;

/** A new sandbox's Gateway name, when none is asked for. */
export function newGatewayName() {
  return `e2e${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/** The Gateway's hostname: one level below the configured domain. */
export function gatewayHost(config, name) {
  return `${name}.${config.domain}`;
}

/**
 * Create the owner with setup's one-time link, as the /setup page does: the
 * same JSON POST, from the Gateway's own origin. Hashing the password can
 * run out of Worker CPU, which the page retries too.
 */
async function claimOwner(link, owner) {
  const url = new URL(link);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("setup's owner link had no token");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(new URL("/api/setup/claim", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin: url.origin },
      body: JSON.stringify({ token, ...owner }),
    });
    if (response.ok) return;
    const text = await response.text();
    const retry =
      (response.status >= 500 && /cpu|exceeded/i.test(text)) || text.includes("CLAIM_IN_PROGRESS");
    if (!retry) throw new Error(`The owner claim was refused (${response.status}): ${text.slice(0, 300)}`);
    await sleep(3_000 * attempt);
  }
  throw new Error("The owner claim kept running out of Worker CPU");
}

/**
 * Install the sandbox's Gateway from `checkout` and create its owner. Access
 * stays off, so the checks sign in with the owner's password.
 */
export async function install({ config, checkout, sandbox }) {
  const host = gatewayHost(config, sandbox.name);
  const owner = {
    name: "E2E Owner",
    email: "e2e-owner@example.com",
    password: randomBytes(18).toString("base64url"),
  };
  await everyapp({
    config,
    cwd: checkout,
    log: path.join(sandbox.dir, "setup.log"),
    args: [
      "setup",
      "--name",
      sandbox.name,
      "--domain",
      host,
      "--account-id",
      config.accountId,
      "--no-access",
      "--yes",
    ],
    onEvent: async (event) => {
      if (event.type === "action_required" && event.action === "claim_owner") {
        await claimOwner(event.data.url, owner);
      }
    },
  });
  return { url: `https://${host}`, owner };
}

/** Deploy the checkout's starter app to the sandbox's Gateway, with that checkout's CLI and SDK. */
export async function deployStarter({ config, checkout, sandbox, log = "deploy-starter.log" }) {
  await everyapp({
    config,
    cwd: path.join(checkout, STARTER_DIR),
    log: path.join(sandbox.dir, log),
    args: ["deploy", "--gateway", sandbox.name, "--yes"],
  });
}

/** The starter config's lines a test app's id, name and provider replace or follow. */
const STARTER_ID = `id: "${STARTER_APP_ID}",`;
const STARTER_NAME = 'name: "Simple Todo",';
const STARTER_MEMBERS = 'members: { access: "read", why: "Shows who can open this app." },';

/**
 * Deploy the checkout's starter as another app, `appId`, listing `provider`
 * with `scopes` when given: what an app that uses a provider looks like to
 * the Gateway. The starter's everyapp.config.ts is changed for the deploy
 * and put back as it was, uncommitted edits included.
 */
export async function deployStarterAs({ config, checkout, sandbox, appId, provider, scopes }) {
  const file = path.join(checkout, STARTER_DIR, "everyapp.config.ts");
  const original = fs.readFileSync(file, "utf8");
  for (const anchor of [STARTER_ID, STARTER_NAME, STARTER_MEMBERS]) {
    if (!original.includes(anchor)) throw new Error(`${file} no longer has \`${anchor}\`: update scripts/e2e/gateway.mjs`);
  }
  const listed = provider
    ? `${STARTER_MEMBERS}\n    ${JSON.stringify(provider)}: { scopes: ${JSON.stringify(scopes)}, why: "e2e: an app that uses ${provider}." },`
    : STARTER_MEMBERS;
  fs.writeFileSync(
    file,
    original
      .replace(STARTER_ID, `id: ${JSON.stringify(appId)},`)
      .replace(STARTER_NAME, `name: ${JSON.stringify(appId)},`)
      .replace(STARTER_MEMBERS, listed),
  );
  try {
    await deployStarter({ config, checkout, sandbox, log: `deploy-${appId}.log` });
  } finally {
    fs.writeFileSync(file, original);
  }
}

/**
 * Set every OAuth client the config keeps for this sandbox's name, with
 * `provider add <id> --from-env`: the preset's own setting names
 * (`provider presets`) carry the client id and secret, so any preset works.
 */
export async function setOAuthClients({ config, checkout, sandbox }) {
  const clients = config.oauthClients.filter((client) => client.sandbox === sandbox.name);
  if (clients.length === 0) return [];
  const done = await everyapp({
    config,
    cwd: checkout,
    log: path.join(sandbox.dir, "provider-presets.log"),
    args: ["provider", "presets"],
  });
  for (const client of clients) {
    const preset = done.data.presets.find((each) => each.id === client.provider);
    if (!preset) throw new Error(`${client.provider} isn't an OAuth preset (pnpm everyapp provider presets).`);
    const [idName, secretName] = preset.settings;
    await everyapp({
      config,
      cwd: checkout,
      log: path.join(sandbox.dir, `provider-add-${client.provider}.log`),
      args: ["provider", "add", client.provider, "--from-env", "--gateway", sandbox.name],
      env: { [idName]: client.clientId, [secretName]: client.clientSecret },
    });
  }
  return clients.map((client) => client.provider);
}

/** Update the sandbox's Gateway to `checkout`'s release: migrations first, then the code. */
export async function update({ config, checkout, sandbox }) {
  await everyapp({
    config,
    cwd: checkout,
    log: path.join(sandbox.dir, "update.log"),
    args: ["update", "--gateway", sandbox.name, "--yes"],
  });
}

/** `status` from `checkout`: its `done` event's data (claimed, inSync, upToDate with that checkout, apps, fixes). */
export async function status({ config, checkout, sandbox, label }) {
  const done = await everyapp({
    config,
    cwd: checkout,
    log: path.join(sandbox.dir, `status-${label}.log`),
    args: ["status", "--gateway", sandbox.name],
  });
  if (!done) throw new Error("status ended without its result");
  return done.data;
}

/** Tear the sandbox's Gateway down, its apps and their resources with it. */
export async function teardown({ config, checkout, sandbox }) {
  await everyapp({
    config,
    cwd: checkout,
    log: path.join(sandbox.dir, "down.log"),
    args: [
      "teardown",
      "--account-id",
      config.accountId,
      "--gateway",
      sandbox.name,
      "--confirm",
      `every-app-gateway-${sandbox.name}`,
    ],
  });
}

/** A page of `context` signed in as the owner, with the password form any member uses (or already signed in). */
export async function signIn(context, gateway) {
  const page = await context.newPage();
  await page.goto(`${gateway.url}/sign-in`);
  if (new URL(page.url()).pathname !== "/sign-in") return page;
  await page.fill('input[name="email"]', gateway.owner.email);
  await page.fill('input[name="password"]', gateway.owner.password);
  await page.press('input[name="password"]', "Enter");
  await page.waitForURL(`${gateway.url}/`);
  return page;
}
