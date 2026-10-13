/**
 * The runtime the CLI needs. cf loads `cloudflare.config.ts` with Node's
 * module hooks and built-in TypeScript stripping, which Node gained in
 * 22.18.0; older Nodes fail with an unhelpful `Unknown file extension ".ts"`,
 * and Bun isn't supported at all.
 */
export const MIN_NODE_VERSION = "22.18.0";

/** Whether this Node version can load a cloudflare.config.ts. */
export function loadsCloudflareConfig(nodeVersion: string): boolean {
  return compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
}

/** Why this runtime can't run everyapp, or null when it can. */
export function unsupportedRuntimeReason(
  versions: NodeJS.ProcessVersions = process.versions,
): string | null {
  if (versions["bun"]) {
    return `everyapp runs on Node.js ${MIN_NODE_VERSION} or newer, not Bun: the Cloudflare CLI can't load cloudflare.config.ts under Bun. Run it with Node (npx everyapp …).`;
  }
  if (!loadsCloudflareConfig(versions.node)) {
    return `everyapp needs Node.js ${MIN_NODE_VERSION} or newer; this is ${versions.node}. The Cloudflare CLI loads cloudflare.config.ts with Node's built-in TypeScript support, which older versions lack. Install a newer Node 22 or 24 and run the command again.`;
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
