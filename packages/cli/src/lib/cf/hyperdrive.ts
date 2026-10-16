/**
 * Hyperdrive configs, by exact name. The origin's password goes to cf only
 * in a request body file (a private temp file, `--body @<file>`), never on
 * the command line, and Cloudflare never returns it.
 */
import type { HyperdriveOrigin } from "@/lib/app/deploySecrets";
import { runCfJson, type CfRunner } from "./runner";
import {
  HyperdriveConfigListOutput,
  HyperdriveConfigOutput,
  type HyperdriveConfig,
} from "./schemas";

const PAGE_SIZE = 20;
const MAX_PAGES = 10;

/**
 * Every Hyperdrive config in the account. A page that brings nothing new
 * ends the listing too, so an API that ignores the page asked for can't
 * loop.
 */
export async function listHyperdrive(cf: CfRunner): Promise<HyperdriveConfig[]> {
  const configs = new Map<string, HyperdriveConfig>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "hyperdrive",
          "list",
          "--per-page",
          String(PAGE_SIZE),
          "--page",
          String(page),
        ],
      },
      HyperdriveConfigListOutput,
    );
    const before = configs.size;
    for (const config of batch) configs.set(config.id, config);
    if (batch.length < PAGE_SIZE || configs.size === before) break;
  }
  return [...configs.values()];
}

export async function findHyperdrive(
  cf: CfRunner,
  name: string,
): Promise<HyperdriveConfig | null> {
  return (await listHyperdrive(cf)).find((config) => config.name === name) ?? null;
}

/** Create a config; fails (`already_exists`) when the name is taken. */
export async function createHyperdrive(
  cf: CfRunner,
  name: string,
  origin: HyperdriveOrigin,
): Promise<string> {
  const config = await runCfJson(
    cf,
    {
      plane: "account",
      files: { "hyperdrive.json": { name, origin } },
      args: (files) => [
        "hyperdrive",
        "create",
        "--body",
        `@${files["hyperdrive.json"]!}`,
      ],
    },
    HyperdriveConfigOutput,
  );
  return config.id;
}

/** Point a config at a new origin (a moved database, new credentials). */
export async function updateHyperdriveOrigin(
  cf: CfRunner,
  id: string,
  origin: HyperdriveOrigin,
): Promise<void> {
  await runCfJson(
    cf,
    {
      plane: "account",
      files: { "hyperdrive.json": { origin } },
      args: (files) => [
        "hyperdrive",
        "update",
        id,
        "--body",
        `@${files["hyperdrive.json"]!}`,
      ],
    },
    HyperdriveConfigOutput,
  );
}

/**
 * Delete a config, decided as for deleteD1 (lib/cf/resources.ts). The
 * database it connects to is untouched.
 */
export async function deleteHyperdrive(cf: CfRunner, id: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["hyperdrive", "delete", id, "--force"],
  });
}

/** Whether a config connects to `origin` (all but the password, which it never shows). */
export function connectsTo(
  config: HyperdriveConfig,
  origin: HyperdriveOrigin,
): boolean {
  const current = config.origin;
  return (
    current?.host === origin.host &&
    (current.port ?? null) === origin.port &&
    current.database === origin.database &&
    current.user === origin.user
  );
}
