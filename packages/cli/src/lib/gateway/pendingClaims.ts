/**
 * `~/.everyapp/pending-claims/<gateway host>.json` (0600, in a 0700
 * directory): a setup link this machine minted for `everyapp setup`, with
 * the secret that retrieves the owner's first deploy token once someone
 * claims it. It lets an interrupted setup show the same link again and
 * finish the login, and `everyapp login --resume` do it alone. Removed
 * once the deploy token is stored.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PendingClaim {
  gatewayUrl: string;
  /** The setup link, `<gateway>/setup#token=est_…`. */
  url: string;
  /** Never printed: it is the CLI's half of the link. */
  cliSecret: string;
  expiresAt: string;
}

function claimsDir(): string {
  return path.join(os.homedir(), ".everyapp", "pending-claims");
}

function claimPath(gatewayHost: string): string {
  return path.join(claimsDir(), `${gatewayHost.toLowerCase()}.json`);
}

export async function writePendingClaim(claim: PendingClaim): Promise<void> {
  const host = new URL(claim.gatewayUrl).host;
  await fs.mkdir(claimsDir(), { recursive: true, mode: 0o700 });
  const target = claimPath(host);
  await fs.writeFile(target, `${JSON.stringify(claim, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(target, 0o600);
}

/** The pending claim for this host, or null (none, or its link expired). */
export async function readPendingClaim(
  gatewayHost: string,
  now = Date.now(),
): Promise<PendingClaim | null> {
  try {
    const claim = JSON.parse(
      await fs.readFile(claimPath(gatewayHost), "utf8"),
    ) as PendingClaim;
    return Date.parse(claim.expiresAt) > now ? claim : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Every pending claim on this machine whose link hasn't expired. */
export async function listPendingClaims(now = Date.now()): Promise<PendingClaim[]> {
  let files: string[];
  try {
    files = await fs.readdir(claimsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const claims = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => readPendingClaim(file.slice(0, -".json".length), now)),
  );
  return claims.filter((claim): claim is PendingClaim => claim !== null);
}

export async function deletePendingClaim(gatewayHost: string): Promise<void> {
  await fs.rm(claimPath(gatewayHost), { force: true });
}
