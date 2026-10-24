import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import chalk from "chalk";
import { DEV_USER } from "@every-app/perimeter/dev";
import { devGatewaySettingsFor, secretNames } from "@every-app/sdk/internal";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import { formatFacts, type Fact } from "@/lib/output/table";
import { CRON_PATH } from "./gatewayServer";
import { DevMode } from "./mode";

interface ReadyBlockOptions {
  manifest: EveryAppCliManifest;
  mode: DevMode;
  appUrl: string;
  appPort: number;
  /** Mirror mode: the separately-run Gateway, and where to log in through the gateway-lite. */
  gatewayUrl: string;
  loginUrl: string;
  /** cloudflare.config.ts declares crons. */
  crons: boolean;
  /** The app's directory, where its .dev.vars is. */
  cwd: string;
}

/** What's running and how to reach it, as one block of facts. */
export function readyBlock({
  manifest,
  mode,
  appUrl,
  appPort,
  gatewayUrl,
  loginUrl,
  crons,
  cwd,
}: ReadyBlockOptions): string {
  const facts = [
    { label: "App", value: chalk.cyan(appUrl) },
    {
      label: "MCP",
      value: `${chalk.cyan(`${appUrl}/mcp`)}  ${chalk.dim(
        mode === DevMode.Mirror
          ? "bearer: a personal access token from the local Gateway"
          : "any bearer token acts as the dev user",
      )}`,
    },
    ...(mode === DevMode.Mirror
      ? [
          {
            label: "Log in",
            value: `${chalk.cyan(loginUrl)}  ${chalk.dim("the session carries to the app")}`,
          },
          {
            label: "Gateway",
            value: `${gatewayUrl} ${chalk.dim("(real login and launcher)")}`,
          },
        ]
      : [
          {
            label: "Dev user",
            value: `${DEV_USER.email} ${chalk.dim(`(${DEV_USER.orgRole} of ${DEV_USER.orgId})`)}`,
          },
        ]),
    // Workflows run under cf dev too; the Vite plugin's local explorer, on
    // the app's own dev server, starts, inspects, pauses and restarts their
    // instances.
    ...(manifest.resources?.workflows?.length
      ? [
          {
            label: "Workflows",
            value: chalk.cyan(`http://127.0.0.1:${appPort}/cdn-cgi/local/explorer`),
          },
        ]
      : []),
    ...emailHint(manifest, appPort),
    // Crons (everyAppWorker's `crons`) run on demand through the gateway-lite.
    ...(crons
      ? [
          {
            label: "Cron",
            value: `curl -X POST ${appUrl}${CRON_PATH} -d '<schedule>'`,
          },
        ]
      : []),
    ...devVarsHint(manifest, cwd),
  ];
  return ["", ...formatFacts(facts).map((line) => `  ${line}`), ""].join("\n");
}

/**
 * How to deliver a message to the app's email() handler locally, when the
 * manifest declares one: miniflare's local delivery endpoint on the app's
 * own dev server (`everyapp dev --help` says what the message needs).
 */
export function emailHint(
  manifest: Pick<EveryAppCliManifest, "email">,
  appPort: number,
): Array<{ label: string; value: string }> {
  if (manifest.email?.inbound !== true) return [];
  return [
    {
      label: "Email",
      value: `curl -X POST "http://127.0.0.1:${appPort}/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" --data-binary @message.eml`,
    },
  ];
}

/** cf's file of an app's local secrets, read in place of the Gateway. */
const DEV_VARS = ".dev.vars";

/**
 * What .dev.vars is missing, as one fact: the keys the SDK can't do
 * without for the manifest's `providers` and `capabilities` when there is
 * no Gateway (OPENROUTER_API_KEY for openrouter, DATAFORSEO_API_KEY for
 * dataforseo, an OAuth client's id and secret, ...) and the app's own
 * `secrets`, less what the file sets to something. The optional ones are
 * never named: email's sender and transports (sendEmail() prints until
 * they are set) and an instance with a default (MASTODON_URL). Nothing
 * when the app needs none or the file has them all. Names only, never
 * values; a hint, since the SDK decides what it does without them (an AI
 * call or integration answers that it isn't set up).
 */
export function devVarsHint(
  manifest: {
    readonly id: string;
    /** Each by name, or as an entry with its need (the settings model). */
    readonly secrets?: ReadonlyArray<string | { readonly name: string }>;
    readonly providers?: ReadonlyArray<string | { readonly id: string }>;
    readonly capabilities?: { readonly [id: string]: unknown };
  },
  cwd: string,
): Fact[] {
  const names = [
    ...new Set([
      ...devGatewaySettingsFor(manifest)
        .filter((need) => need.required)
        .map((need) => need.name),
      ...secretNames(manifest),
    ]),
  ];
  if (names.length === 0) return [];
  const set = readDevVars(cwd);
  const missing = set ? names.filter((name) => !set[name]) : names;
  if (missing.length === 0) return [];
  const list = missing.join(", ");
  return [
    {
      label: "Dev vars",
      value: `${
        set
          ? `${DEV_VARS} is missing ${list}`
          : `no ${DEV_VARS} yet: add ${list}`
      }  ${chalk.dim(`(the app's keys for local runs; see ${CLI} dev --help)`)}`,
    },
  ];
}

/**
 * The app's .dev.vars as cf reads it (dotenv syntax); null when there is
 * none, or when it can't be read: a hint never ends the run.
 */
function readDevVars(cwd: string): Record<string, string | undefined> | null {
  try {
    return parseEnv(fs.readFileSync(path.join(cwd, DEV_VARS), "utf8"));
  } catch {
    return null;
  }
}
