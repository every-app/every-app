export { describeVectorizeShape, hasVectorizeShape } from "@every-app/perimeter/install";
/**
 * Vectorize indexes through `cf vectorize`, by name: an index has no other
 * id. Its shape (dimensions and metric, or a preset of Cloudflare's) is
 * fixed when it is created. A create always sends a request body file
 * (`--body @<file>`), because cf 1.0.0-beta.14 reads a flag value that
 * starts with `@` as a file to load, and the Workers AI presets do
 * (`--config-preset @cf/baai/…` fails with ENOENT; seen live 2026-10-24).
 */
import { isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import {
  VectorizeIndexListOutput,
  VectorizeIndexOutput,
  type VectorizeIndex,
} from "./schemas";

/** What an index is made with: dimensions and a metric, or a preset. */
export type VectorizeShape = { dimensions: number; metric: string } | { preset: string };

/**
 * The index with this name, or null when the account has none (or has
 * just deleted it: Cloudflare answers 410 for a while, and a create of the
 * name works at once).
 */
export async function getVectorizeIndex(
  cf: CfRunner,
  name: string,
): Promise<VectorizeIndex | null> {
  try {
    return await runCfJson(
      cf,
      { plane: "account", args: ["vectorize", "get", name] },
      VectorizeIndexOutput,
    );
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/** Every Vectorize index in the account (cf lists them in one answer). */
export function listVectorizeIndexes(cf: CfRunner): Promise<VectorizeIndex[]> {
  return runCfJson(
    cf,
    { plane: "account", args: ["vectorize", "list"] },
    VectorizeIndexListOutput,
  );
}

/** Create an index; fails (`already_exists`) when the name is taken. */
export async function createVectorizeIndex(cf: CfRunner, name: string, shape: VectorizeShape): Promise<VectorizeIndex> {
  return runCfJson(
    cf,
    {
      plane: "account",
      files: { "vectorize.json": { name, config: shape } },
      args: (files) => ["vectorize", "create", "--body", `@${files["vectorize.json"]!}`],
    },
    VectorizeIndexOutput,
  );
}

/**
 * Delete an index and its vectors. `--force` answers cf's confirmation,
 * decided as for `deleteD1` (lib/cf/resources.ts). Throws `not_found` when
 * it is gone already.
 */
export async function deleteVectorizeIndex(
  cf: CfRunner,
  name: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["vectorize", "delete", name, "--force"],
  });
}
