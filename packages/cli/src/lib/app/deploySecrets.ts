/**
 * The app's secrets file, `.everyapp/secrets.env` in the app root: what
 * `everyapp deploy` itself needs to reach the app's Postgres database, in
 * dotenv syntax. The deploy reads it and never uploads, prints or records a
 * value from it; `.everyapp/` is kept out of git.
 *
 *   POSTGRES_DATABASE_URL   the database `drizzle-kit migrate` runs against
 *                           (migrations.dialect "postgresql")
 *   <BINDING>_ORIGIN_URL    the origin a new Hyperdrive config for that
 *                           binding connects to; an app with one config may
 *                           leave it to POSTGRES_DATABASE_URL
 *
 * Unlike the app's own secrets (`everyapp secret set`), nothing here
 * reaches the Worker: it binds the Hyperdrive config, which holds the
 * origin's credentials in Cloudflare.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { EveryAppError } from "@/lib/errors";
import { ensureGitignored } from "@/lib/gitignore";
import type { EveryAppCliManifest } from "@/lib/manifest";

export const APP_SECRETS_FILE = ".everyapp/secrets.env";
export const POSTGRES_URL_VARIABLE = "POSTGRES_DATABASE_URL";

export type AppSecrets = Readonly<Record<string, string>>;

/** The app's secrets file, or nothing when it has none. */
export async function readAppSecrets(cwd: string): Promise<AppSecrets> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cwd, APP_SECRETS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  ensureGitignored(cwd, `${path.dirname(APP_SECRETS_FILE)}/`);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(raw))) {
    if (value?.trim()) values[name] = value.trim();
  }
  return values;
}

/** The variable holding the origin of a Hyperdrive binding's config. */
export function hyperdriveOriginVariable(binding: string): string {
  return `${binding}_ORIGIN_URL`;
}

/**
 * The origin URL for a Hyperdrive binding, and the variable it came from:
 * its own, or POSTGRES_DATABASE_URL when it is the app's only config.
 */
export function hyperdriveOriginUrl(
  secrets: AppSecrets,
  manifest: Pick<EveryAppCliManifest, "resources">,
  binding: string,
): { url: string; variable: string } | null {
  const own = hyperdriveOriginVariable(binding);
  if (secrets[own]) return { url: secrets[own], variable: own };
  if (
    (manifest.resources?.hyperdrive ?? []).length === 1 &&
    secrets[POSTGRES_URL_VARIABLE]
  ) {
    return {
      url: secrets[POSTGRES_URL_VARIABLE],
      variable: POSTGRES_URL_VARIABLE,
    };
  }
  return null;
}

/** A Hyperdrive origin, as Cloudflare's API takes it. */
export interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql" | "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

const DEFAULT_PORTS = { postgres: 5432, postgresql: 5432, mysql: 3306 };

/**
 * Parse an origin URL (`postgres://user:password@host:5432/database`). A
 * problem names the variable, never the value, which holds a password.
 */
export function parseOriginUrl(url: string, variable: string): HyperdriveOrigin {
  const invalid = (why: string) =>
    new EveryAppError(
      "DATABASE_URL_INVALID",
      `${variable} in ${APP_SECRETS_FILE} ${why}; write it as postgres://<user>:<password>@<host>:<port>/<database>.`,
    );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("isn't a URL");
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "postgres" && scheme !== "postgresql" && scheme !== "mysql") {
    throw invalid("isn't a postgres:// or mysql:// URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!parsed.hostname || !database || !user || !password) {
    throw invalid("needs a host, a database, a user and a password");
  }
  return {
    scheme,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[scheme],
    database,
    user,
    password,
  };
}

/** `text` with every value of `secrets` replaced, for output that may echo one. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("***");
  }
  return redacted;
}
