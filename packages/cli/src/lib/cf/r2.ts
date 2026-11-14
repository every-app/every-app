/**
 * R2 buckets through cf: listing by name and creating one for an app's
 * deploy (ensureAppBuckets, @every-app/perimeter/install resources.ts),
 * deleting an empty one for the teardown, and whether the account has R2
 * at all (setup and update check it first).
 * Checked against cf@1.0.0-beta.14 on 2026-10-24.
 */
import { isCfError } from "./errors";
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

/** Where an account turns R2 on. */
export function r2Url(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/r2/overview`;
}

/**
 * Whether the account has R2 turned on. One that never did answers every
 * bucket call with 10042 (`r2_not_enabled`) until someone turns it on in
 * the dashboard; no API or cf command does. The listing is the one a
 * deploy already makes, and what it finds doesn't matter. Any other
 * failure is thrown: it says nothing about R2.
 */
export async function r2Enabled(cf: CfRunner): Promise<boolean> {
  try {
    await listR2Buckets(cf, "everyapp");
    return true;
  } catch (error) {
    if (isCfError(error, "r2_not_enabled")) return false;
    throw error;
  }
}

/** Whether a bucket named exactly `name` exists. */
export async function findR2Bucket(cf: CfRunner, name: string): Promise<boolean> {
  return (await listR2Buckets(cf, name)).includes(name);
}

/** Create a bucket; fails (`already_exists`) when the name is taken. */
export async function createR2Bucket(cf: CfRunner, name: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["r2", "buckets", "create", "--name", name],
  });
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
