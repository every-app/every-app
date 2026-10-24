/**
 * R2 buckets through cf, for the teardown: everyapp never creates one
 * (an app's buckets get their assigned names and are made in the
 * dashboard), so only listing by name and deleting an empty one are here.
 * Checked against cf@1.0.0-beta.14 on 2026-10-24.
 */
import { runCfJson, type CfRunner } from "./runner";
import { R2BucketListOutput } from "./schemas";

/**
 * The most buckets one call returns. R2 paginates with a cursor cf doesn't
 * print, so one page is what callers get: plenty for a test account.
 */
const PAGE_SIZE = 100;

/** The names of the account's buckets with `contains` in their names. */
export function listR2Buckets(cf: CfRunner, contains: string): Promise<string[]> {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: ["r2", "buckets", "list", "--name-contains", contains, "--per-page", String(PAGE_SIZE)],
    },
    R2BucketListOutput,
  ).then((buckets) => buckets.map((bucket) => bucket.name));
}

/**
 * Delete a bucket (`--force` answers cf's confirmation). R2 refuses a
 * bucket with objects, unfinished multipart uploads or event notification
 * rules: the caller says so and leaves it.
 */
export async function deleteR2Bucket(cf: CfRunner, name: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["r2", "buckets", "delete", name, "--force"],
  });
}
