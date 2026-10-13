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
