/**
 * This machine's e2e settings (docs/runbooks/e2e.md): the Cloudflare account
 * sandbox Gateways go into, the domain their hostnames go under, the API
 * token they're installed and torn down with, where each sandbox's state
 * and logs are kept, and the OAuth clients registered for a sandbox name
 * (its callback URL is `https://<name>.<domain>/connect/<provider>/callback`,
 * the same every time that name comes up). The person writes the file themselves, mode 600: the
 * token never travels on a command line, through a chat or into the
 * repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_NAME } from "./gateway.mjs";

export const CONFIG_PATH =
  process.env.EVERYAPP_E2E_CONFIG ?? path.join(os.homedir(), ".config", "everyapp", "e2e.json");

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".cache", "everyapp", "e2e");
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The settings, checked; throws with what to fix. */
export function readConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(`No e2e config at ${CONFIG_PATH}\nWrite it as docs/runbooks/e2e.md says.`);
  }
  if ((fs.statSync(CONFIG_PATH).mode & 0o077) !== 0) {
    throw new Error(`${CONFIG_PATH} holds a Cloudflare token and others can read it: chmod 600 it.`);
  }
  const raw = JSON.parse(text);
  if (!ACCOUNT_ID.test(raw.accountId ?? "")) {
    throw new Error(`${CONFIG_PATH}: accountId must be the account's 32-character id.`);
  }
  if (!DOMAIN.test(raw.domain ?? "")) {
    throw new Error(`${CONFIG_PATH}: domain must be a hostname under one of the account's zones, like e2e.example.com.`);
  }
  if (typeof raw.token !== "string" || raw.token.length === 0) {
    throw new Error(`${CONFIG_PATH}: token must be a Cloudflare API token for the account.`);
  }
  return {
    accountId: raw.accountId,
    domain: raw.domain,
    token: raw.token,
    stateDir: raw.stateDir ? path.resolve(raw.stateDir) : DEFAULT_STATE_DIR,
    oauthClients: readOAuthClients(raw.oauthClients ?? {}),
  };
}

/** `{ "<provider id>": { sandbox, clientId, clientSecret } }`, checked. */
function readOAuthClients(raw) {
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${CONFIG_PATH}: oauthClients must map a provider id to its client.`);
  }
  return Object.entries(raw).map(([provider, client]) => {
    if (!GATEWAY_NAME.test(client?.sandbox ?? "")) {
      throw new Error(`${CONFIG_PATH}: oauthClients.${provider}.sandbox must be the sandbox name its callback was registered for.`);
    }
    for (const field of ["clientId", "clientSecret"]) {
      if (typeof client[field] !== "string" || client[field].length === 0) {
        throw new Error(`${CONFIG_PATH}: oauthClients.${provider}.${field} is missing.`);
      }
    }
    return { provider, sandbox: client.sandbox, clientId: client.clientId, clientSecret: client.clientSecret };
  });
}
