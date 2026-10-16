/**
 * `~/.everyapp/installs.json` (0600): what this machine remembers about the
 * gateways it deployed, keyed by gateway host. Only a cache and a source of
 * defaults (re-running `everyapp gateway deploy` keeps the domain and
 * account): the install row in the gateway's own D1 is the truth, and every
 * run re-checks it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CachedInstall {
  gatewayHost: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
  databaseId: string;
  oauthKvId: string;
  deployKvId: string;
  releaseVersion: string;
  releaseSha256: string;
  updatedAt: string;
}

interface InstallsFile {
  installs: Record<string, CachedInstall>;
}

function installsPath(): string {
  return path.join(os.homedir(), ".everyapp", "installs.json");
}

async function readFile(): Promise<InstallsFile> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(installsPath(), "utf8"),
    ) as Partial<InstallsFile>;
    return {
      installs:
        parsed.installs && typeof parsed.installs === "object"
          ? parsed.installs
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { installs: {} };
    }
    throw error;
  }
}

async function listCachedInstalls(): Promise<CachedInstall[]> {
  return Object.values((await readFile()).installs);
}

async function readCachedInstall(
  gatewayHost: string,
): Promise<CachedInstall | null> {
  return (await readFile()).installs[gatewayHost.toLowerCase()] ?? null;
}

/** The gateway this machine deployed: for `domain`, or the only one. */
export async function rememberedInstall(
  domain?: string,
): Promise<CachedInstall | null> {
  if (domain) return readCachedInstall(domain);
  const installs = await listCachedInstalls();
  return installs.length === 1 ? installs[0]! : null;
}

export async function writeCachedInstall(install: CachedInstall): Promise<void> {
  const file = await readFile();
  file.installs[install.gatewayHost.toLowerCase()] = install;
  const target = installsPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(target, 0o600);
}
