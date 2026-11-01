/**
 * The runtime the CLI needs. cf loads `cloudflare.config.ts` with Node's
 * module hooks and built-in TypeScript stripping, which Node gained in
 * 22.18.0; older Nodes fail with an unhelpful `Unknown file extension ".ts"`,
 * and Bun isn't supported at all.
 */
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";

export const MIN_NODE_VERSION = "22.18.0";

/**
 * The Node flag every build everyapp spawns runs with. A TanStack Start
 * build prerenders through a preview server: the server listens on
 * `localhost`, the client connects to `127.0.0.1`. With Node's default
 * DNS result order (`verbatim`) on a Linux whose /etc/hosts maps
 * `localhost` to `::1` first (Debian bookworm does), the server binds IPv6
 * only and the build fails with `connect ECONNREFUSED 127.0.0.1:<port>`
 * from `@tanstack/start-plugin-core`'s prerender: GATEWAY_BUILD_FAILED on
 * the Gateway's `build:release`, and the same from `cf build` of an app.
 * Seen on every Linux first setup, reproduced in the onboarding loop's
 * container on 2026-10-24; macOS resolves `localhost` to 127.0.0.1 first
 * and never hits it.
 */
export const BUILD_NODE_FLAG = "--dns-result-order=ipv4first";

/**
 * The NODE_OPTIONS a build child gets: whatever the person already set,
 * then {@link BUILD_NODE_FLAG} (once).
 */
export function buildNodeOptions(current: string | undefined): string {
  const options = (current ?? "").trim();
  if (options.split(/\s+/).includes(BUILD_NODE_FLAG)) return options;
  return options ? `${options} ${BUILD_NODE_FLAG}` : BUILD_NODE_FLAG;
}

/** Whether this Node version can load a cloudflare.config.ts. */
export function loadsCloudflareConfig(nodeVersion: string): boolean {
  return compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
}

/** Why this runtime can't run everyapp (UNSUPPORTED_RUNTIME), or null when it can. */
export function unsupportedRuntime(
  versions: NodeJS.ProcessVersions = process.versions,
): EveryAppError | null {
  if (versions["bun"]) {
    return new EveryAppError(
      "UNSUPPORTED_RUNTIME",
      "everyapp runs on Node.js, not Bun\nThe Cloudflare CLI can't load cloudflare.config.ts under Bun.",
      { rerun: thisCommand(), rerunNote: `with Node.js ${MIN_NODE_VERSION} or newer` },
    );
  }
  if (!loadsCloudflareConfig(versions.node)) {
    return new EveryAppError(
      "UNSUPPORTED_RUNTIME",
      `everyapp needs Node.js ${MIN_NODE_VERSION} or newer; this is ${versions.node}\nThe Cloudflare CLI loads cloudflare.config.ts with Node's built-in TypeScript support.`,
      { fix: "install Node 22 or 24, then run the command again" },
    );
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string) =>
    version
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
