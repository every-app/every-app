/**
 * Where the CLI runs cf and keeps the files it hands to cf:
 * `~/.everyapp/cf`, never the shared temp directory.
 *
 * cf looks for `cloudflare.config.ts` in its working directory and every
 * parent up to `/`, and runs the first one it finds, even for API commands
 * that only read the account or compliance region from it. In `/tmp` any
 * local user could plant one, or create our directory first, and run code
 * with the deploy's credentials and secrets. So:
 *
 *  - account-plane calls run in `~/.everyapp/cf/neutral`, and secrets
 *    files, extracted gateway releases and the patched copy cf deploys from
 *    live under `~/.everyapp/cf/tmp`;
 *  - those directories must be real directories (lstat, no symlinks) that
 *    we own with mode 0700, and are recreated when they aren't;
 *  - every directory above them, up to `/`, must be owned by us or root and
 *    writable by nobody else, so no one else can plant a config there later
 *    (run as root, a parent may be another user's: root trusts the HOME it
 *    runs in, though never a `~/.everyapp` someone else owns);
 *  - and none of them may hold a cloudflare.config.ts now.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EveryAppError } from "@/lib/errors";

const CONFIG_FILE = "cloudflare.config.ts";
const PRIVATE_MODE = 0o700;
// Group- or world-writable.
const WRITABLE_BY_OTHERS = 0o022;

/** The empty directory account-plane cf calls run in. */
export async function cfNeutralDir(): Promise<string> {
  return ensureCfDir("neutral");
}

/** The prefix of the directories holding the files one cf call reads. */
export const CF_FILES_PREFIX = "files-";

/**
 * A new private directory for files cf reads, or a tree cf runs in. Its
 * name carries this run's pid, so another run's sweep can tell it's in use.
 */
export async function makeCfTempDir(prefix: string): Promise<string> {
  const parent = await ensureCfDir("tmp");
  await removeStale(parent);
  return fs.mkdtemp(path.join(parent, `${prefix}${process.pid}-`));
}

// Far longer than a run lives: an unattended deploy times out after 15
// minutes, and a gateway deploy that waits for the lease, migrates and
// deploys three times is still well under a day.
const STALE_MS = 24 * 60 * 60_000;

/**
 * What runs killed outright (SIGKILL, a crash) left behind, secrets files
 * included: an interrupt cleans up after itself, a kill can't. A tree goes
 * once its run is gone (the pid in its name; one on another machine
 * sharing this HOME looks gone too) and it hasn't changed for a day, by
 * ctime: tar can't backdate that, as it does an extracted release's mtime
 * (to its build time).
 */
async function removeStale(parent: string): Promise<void> {
  const cutoff = Date.now() - STALE_MS;
  for (const entry of await fs.readdir(parent).catch(() => [])) {
    const pid = Number(/-(\d+)-[^-]+$/.exec(entry)?.[1]);
    if (pid && isRunning(pid)) continue;
    const target = path.join(parent, entry);
    const stat = await lstatOrNull(target).catch(() => null);
    if (stat && stat.ctimeMs < cutoff) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A directory holding only `node`: a link to the Node running this CLI.
 * cf starts `pnpm vite …`, and both run on the `node` they find on PATH,
 * which a per-directory nvm or asdf pin can make older than 22.18 (too old
 * to load a cloudflare.config.ts). First on cf's PATH, it pins them to this
 * Node without changing which pnpm, or anything else, they find. (A Volta
 * shim puts its pin first again; toolchain.ts catches that.) Windows gets
 * this Node's own directory instead (links there need privileges).
 */
export async function thisNodeBinDir(): Promise<string> {
  if (process.platform === "win32") return path.dirname(process.execPath);
  const parent = await ensureCfDir("bin");
  // One per Node binary, so runs on different Nodes never fight over it.
  const dir = path.join(
    parent,
    createHash("sha256").update(process.execPath).digest("hex").slice(0, 16),
  );
  await ensurePrivateDir(dir);
  const link = path.join(dir, "node");
  if ((await fs.readlink(link).catch(() => null)) !== process.execPath) {
    await fs.rm(link, { force: true });
    try {
      await fs.symlink(process.execPath, link);
    } catch (error) {
      // Another run made the same link first.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return dir;
}

async function ensureCfDir(name: string): Promise<string> {
  await refuseSudoInUsersHome();
  const everyapp = path.join(os.homedir(), ".everyapp");
  await ensureEveryappDir(everyapp);
  const cfHome = path.join(everyapp, "cf");
  await ensurePrivateDir(cfHome);
  const dir = path.join(cfHome, name);
  await ensurePrivateDir(dir);
  await assertNoPlantableAncestor(dir);
  return dir;
}

/**
 * `sudo everyapp …` where sudo keeps HOME (macOS does): root would make,
 * or take over, the user's ~/.everyapp, and the user's own runs could no
 * longer use it.
 */
async function refuseSudoInUsersHome(): Promise<void> {
  const sudoUid = Number(process.env["SUDO_UID"]);
  if (process.getuid?.() !== 0 || !Number.isInteger(sudoUid) || sudoUid === 0) {
    return;
  }
  const home = await fs.stat(os.homedir()).catch(() => null);
  if (home?.uid === sudoUid) {
    throw new EveryAppError(
      "UNSAFE_CF_DIRECTORY",
      `everyapp is running as root (sudo) with your HOME, ${os.homedir()}: it would leave ~/.everyapp there to root. Run it without sudo.`,
    );
  }
}

/**
 * `~/.everyapp` also holds what cf runs with, so it is never recreated:
 * created 0700 when missing, refused when someone else could write to it.
 * Older CLIs created it with the umask's mode (0775 under umask 002): when
 * it is ours, and so is everything in it, it is made 0700. (It may be a
 * symlink; the ancestor check walks its real path.)
 */
async function ensureEveryappDir(dir: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(dir, { recursive: true, mode: PRIVATE_MODE });
    return;
  }
  if (!stat.isDirectory()) throw unsafe(dir, "isn't a directory");
  const problem = othersCanWrite(stat);
  if (!problem) return;
  if (stat.uid !== process.getuid?.() || !(stat.mode & WRITABLE_BY_OTHERS)) {
    throw unsafe(dir, problem);
  }
  // Someone else could have put a file here while it was open: never one
  // they own. (cloudflare.config.ts is refused by the ancestor check.)
  for (const entry of await fs.readdir(dir)) {
    const owner = (await fs.lstat(path.join(dir, entry))).uid;
    if (owner !== stat.uid) {
      throw unsafe(
        dir,
        `${problem}, and ${entry} in it belongs to another user`,
      );
    }
  }
  await fs.chmod(dir, PRIVATE_MODE);
}

/** A real directory we own with mode 0700, recreated when it isn't. */
async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    const stat = await lstatOrNull(dir);
    if (stat && isPrivateDir(stat)) return;
    if (stat) {
      // Not a real directory of ours, or open to others: whatever is in it
      // may have been put there by someone else. fs.rm removes a symlink
      // itself, never what it points to.
      await fs.rm(dir, { recursive: true, force: true });
    }
    try {
      await fs.mkdir(dir, { mode: PRIVATE_MODE });
    } catch (error) {
      // Another everyapp run created it first; it is checked below.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const created = await fs.lstat(dir);
    if (created.isDirectory()) {
      // mkdir's mode is filtered through the umask.
      await fs.chmod(dir, PRIVATE_MODE);
    }
    if (!isPrivateDir(await fs.lstat(dir))) {
      throw unsafe(dir, "can't be made a private directory");
    }
  } catch (error) {
    if (error instanceof EveryAppError) throw error;
    throw unsafe(
      dir,
      `can't be made a private directory (${(error as Error).message}; was everyapp run with sudo?)`,
    );
  }
}

function isPrivateDir(stat: Stats): boolean {
  if (!stat.isDirectory()) return false;
  // Windows has no POSIX owners or modes; the profile directory is private.
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return stat.uid === uid && (stat.mode & 0o777) === PRIVATE_MODE;
}

/**
 * Why someone other than us (or root) can create files in this directory.
 * Exported for tests, which can't run as root.
 */
export function othersCanWrite(
  stat: Pick<Stats, "uid" | "mode">,
  {
    uid = process.getuid?.(),
    parent = false,
  }: { uid?: number; parent?: boolean } = {},
): string | null {
  if (uid === undefined) return null;
  // Root running in someone's HOME already runs what they control there
  // (their projects, their PATH), so a parent they own is no one else's
  // to it: CI containers run as root with the runner user's HOME.
  const trustedOwner = stat.uid === uid || stat.uid === 0 || (parent && uid === 0);
  if (!trustedOwner) return "is owned by another user";
  if (stat.mode & WRITABLE_BY_OTHERS) return "is writable by other users";
  return null;
}

/**
 * cf runs the first cloudflare.config.ts in its working directory or any
 * parent. Refuse a directory where one exists, or where another user could
 * put one.
 */
async function assertNoPlantableAncestor(dir: string): Promise<void> {
  for (let current = await fs.realpath(dir); ; current = path.dirname(current)) {
    const problem = othersCanWrite(await fs.lstat(current), { parent: true });
    if (problem) {
      throw new EveryAppError(
        "UNSAFE_CF_DIRECTORY",
        `${current} ${problem}, so everyapp won't run cf below it (in ${dir}): cf runs any cloudflare.config.ts it finds in a parent of its working directory. Make it writable only by you (chmod go-w "${current}"), or run everyapp with a HOME that is.`,
      );
    }
    const config = path.join(current, CONFIG_FILE);
    if (await isFile(config)) {
      throw new EveryAppError(
        "UNSAFE_CF_DIRECTORY",
        `cf would run ${config} in every command everyapp starts in ${dir}: it loads a cloudflare.config.ts from any parent of its working directory. Move that file into a project directory, then run this again.`,
      );
    }
    if (path.dirname(current) === current) return;
  }
}

function unsafe(dir: string, problem: string): EveryAppError {
  return new EveryAppError(
    "UNSAFE_CF_DIRECTORY",
    `${dir} ${problem}. everyapp runs cf and keeps the files it hands to cf (secrets among them) there, so only you may be able to write to it. Fix or remove it, then run this again.`,
  );
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** As cf checks it: `stat`, following links, says it's a file. */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}
