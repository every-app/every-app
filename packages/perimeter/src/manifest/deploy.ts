/**
 * The deploy contract between the gateway and the everyapp CLI: how the
 * gateway's service bindings to app Workers are named, and the digest the
 * gateway's status endpoint reports so the CLI can check which apps the live
 * gateway binds without the public endpoint listing them.
 */

/** Prefix of the gateway's service bindings to app Workers. */
export const APP_BINDING_PREFIX = "APP__";

/** The gateway's service binding to an app Worker, e.g. `APP__every-todo`. */
export function appBindingName(workerName: string): string {
  return `${APP_BINDING_PREFIX}${workerName}`;
}

/** SHA-256 (hex) of the sorted binding names, one per line. */
export async function appBindingsDigest(
  bindingNames: Iterable<string>,
): Promise<string> {
  const text = [...bindingNames].sort().join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The hosted deploy API's contract (third-party apps on the hosted
 * gateway): the CLI builds an app with these sentinel deploy inputs, and
 * the gateway's deployer rewrites every binding they reach. Nothing the
 * build makes of them may survive the upload: the deployer refuses a
 * bundle whose bindings it can't rewrite.
 */
export const HOSTED_DEPLOY_SENTINEL = Object.freeze({
  // Holds the resource separator, so no registry Worker is ever named so.
  workerName: "every-hosted--sentinel",
  organizationId: "everyapp-hosted-deploy-sentinel",
  d1Name: "every-hosted--sentinel--d1",
  d1Id: "everyapp-hosted-deploy-sentinel-d1",
  publicKey:
    "-----BEGIN PUBLIC KEY-----\nEVERYAPPHOSTEDDEPLOYSENTINEL\n-----END PUBLIC KEY-----\n",
});

/**
 * The deploy API's protocol, stamped by the CLI on every upload. The
 * gateway refuses a stamp below its floor, so a CLI that packages a bundle
 * the gateway no longer reads the same way is told to upgrade.
 */
export const HOSTED_DEPLOY_PROTOCOL = 1;
export const MIN_HOSTED_DEPLOY_PROTOCOL = 1;

/**
 * Names of the multipart parts of a deploy upload: the evaluated
 * manifest, the stamp, the Build Output's worker.config.json, then one
 * part per bundle module, static asset and migration, named after its
 * path (`module:index.js`, `asset:/favicon.ico`, `migration:0000_init.sql`).
 */
export const HOSTED_DEPLOY_PARTS = Object.freeze({
  manifest: "manifest",
  stamp: "stamp",
  worker: "worker",
  modulePrefix: "module:",
  assetPrefix: "asset:",
  migrationPrefix: "migration:",
});

export type BundleModuleType =
  "esm" | "cjs" | "text" | "data" | "wasm" | "sourcemap";

const MODULE_RULES: ReadonlyArray<[RegExp, BundleModuleType]> = [
  [/\.(m?js)$/, "esm"],
  [/\.cjs$/, "cjs"],
  [/\.map$/, "sourcemap"],
  [/\.wasm$/, "wasm"],
  [/\.(txt|html|sql)$/, "text"],
  [/\.bin$/, "data"],
];

/**
 * What a file of the Build Output's bundle is when uploaded: the type its
 * manifest declares, else the one cf's default rules give its extension,
 * else null (not a module: cf doesn't upload it either).
 */
export function bundleModuleType(
  path: string,
  declared?: string,
): BundleModuleType | null {
  if (declared !== undefined) {
    return (MODULE_RULES.map(([, type]) => type) as string[]).includes(declared)
      ? (declared as BundleModuleType)
      : null;
  }
  return MODULE_RULES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}
