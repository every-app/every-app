import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import chalk from "chalk";
import { DEV_USER } from "@every-app/perimeter/dev";
import {
  aiProviderSettings,
  appSettings,
  CAPABILITIES,
  CATALOG,
  DEV_PROVIDERS_DIR,
  devAiProvider,
  evaluateAppSettings,
  isCapabilityId,
  providerRegistry,
  type AppSetting,
  type CapabilityLookup,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
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
    // The app's own dev server, for scripts that bring their own identity.
    {
      label: "App port",
      value: `http://127.0.0.1:${appPort}  ${chalk.dim(`direct: send x-everyapp-identity: $(${CLI} dev token)`)}`,
    },
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
    ...secretsStoreHint(manifest),
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

/**
 * What a Secrets Store binding does locally, when the manifest declares
 * one: it reads Miniflare's local store, which nothing seeds yet (`.dev.vars`
 * doesn't reach the binding, and cf has no local `secrets create`), so
 * `get()` throws until the secret is put there (dev.md, "Secrets Store").
 */
export function secretsStoreHint(
  manifest: Pick<EveryAppCliManifest, "resources">,
): Array<{ label: string; value: string }> {
  const bindings = (manifest.resources?.secretsStore ?? []).map((entry) => entry.name);
  if (bindings.length === 0) return [];
  return [
    {
      label: "Secrets Store",
      value: `${bindings.join(", ")} ${chalk.dim(
        `${bindings.length === 1 ? "is" : "are"} empty locally: get() throws until seeded (https://everyapp.com/docs/agent/dev#secrets-store-in-development)`,
      )}`,
    },
  ];
}

/** cf's file of an app's local secrets, read in place of the Gateway. */
const DEV_VARS = ".dev.vars";

/**
 * What .dev.vars is missing, as one fact: the settings the manifest
 * declares (`appSettings`: its `providers`, `capabilities` and `secrets`,
 * each with the need its entry marks) that the app can't run without
 * locally, less what the file sets to something. A required setting is
 * named when a name of it is unset (OPENROUTER_API_KEY for openrouter,
 * DATAFORSEO_API_KEY for dataforseo, an OAuth client's id and secret, the
 * app's own MAIN_SECRET, ...); an any-of group is met once any member is
 * set, and until then reads "one of OPENROUTER_API_KEY, OPENAI_API_KEY";
 * an optional setting is never named. Nothing when the app needs none or
 * the file has them all. Names only, never values; a hint, since the SDK
 * decides what it does without them (an AI call or integration answers
 * that it isn't set up).
 */
export function devVarsHint(
  manifest: SettingsManifestLike,
  cwd: string,
): Fact[] {
  const settings = devSettings(manifest, devProviderLookup(cwd));
  if (settings.length === 0) return [];
  const set = readDevVars(cwd);
  const report = evaluateAppSettings(settings, (_holder, name) =>
    Boolean(set?.[name]),
  );
  if (report.ready) return [];
  // The unset names of every required setting, in manifest order, then
  // each any-of group none of whose members is set.
  const names: string[] = [];
  for (const setting of report.unmet) {
    if (setting.need.kind !== "required") continue;
    for (const name of setting.names) {
      if (!set?.[name] && !names.includes(name)) names.push(name);
    }
  }
  const groups = report.groups
    .filter((group) => !group.met)
    .map(
      (group) =>
        `one of ${group.members.map((member) => member.names.join(" with ")).join(", ")}`,
    );
  const list = [...(names.length > 0 ? [names.join(", ")] : []), ...groups].join(
    " and ",
  );
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
 * The manifest's settings as a local run needs them, where the model is
 * silent about dev. There is no install, so a provider needs everything
 * its URL does (Workers AI's CLOUDFLARE_ACCOUNT_ID, which the Gateway's
 * view leaves out as the install's). A service capability's settings are
 * not needed, since the SDK's stand-ins work without them (sendEmail()
 * prints until EMAIL_FROM and a transport are set; listMembers() answers
 * from the dev identity); nor are the AI proxy's extra routes, which the
 * direct calls don't go through.
 */
function devSettings(manifest: SettingsManifestLike, lookup: CapabilityLookup): AppSetting[] {
  return appSettings(manifest, lookup).flatMap((setting): AppSetting[] => {
    switch (setting.kind) {
      case "provider": {
        const spec = devAiProvider(setting.id);
        return [spec ? { ...setting, names: aiProviderSettings(spec) } : setting];
      }
      case "capability":
        return isCapabilityId(setting.id) &&
          CAPABILITIES[setting.id].mode === "service"
          ? []
          : [setting];
      case "ai-routes":
        return [];
      // The default model in dev: the first provider of the order whose
      // settings .dev.vars has (the SDK's fallback), so the names are the
      // first candidate's and any candidate's settings count.
      case "ai-default":
        return [setting];
      // A remote MCP app is the Gateway's own row, never an app run here.
      case "remote-mcp":
        return [];
      case "secret":
        return [setting];
      // Set in .dev.vars like a secret; one with a default is optional,
      // and the dev Worker reads the default.
      case "setting":
        return [setting];
    }
  });
}

/**
 * The catalog, and each provider registered on a Gateway that the app
 * keeps a spec of for local runs (`.everyapp/providers/<id>.json`, which
 * `provider add` in the app's directory and `provider show <id> --save`
 * write): what the SDK's dev fallback reaches, so the settings a local run
 * needs include a registered provider's key. A file that doesn't parse is
 * left out (the SDK names it when the app calls the provider).
 */
export function devProviderLookup(cwd: string): CapabilityLookup {
  const dir = path.join(cwd, DEV_PROVIDERS_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return CATALOG;
  }
  const rows = files.flatMap((name) => {
    try {
      const spec: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const id =
        spec && typeof spec === "object" && typeof (spec as { id?: unknown }).id === "string"
          ? (spec as { id: string }).id
          : name.replace(/\.json$/, "");
      return [{ id, spec }];
    } catch {
      return [];
    }
  });
  return rows.length > 0 ? providerRegistry(rows) : CATALOG;
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
