/**
 * Which Gateway a person picked, when the login sees several
 * (./discover.ts). Two memories, both only ever choosing among the
 * Gateways discovery found just now, never in place of finding them:
 *
 *  - this run's pick: a command that opens the Gateway twice (`provider
 *    add` then the key's `secret set`, `configure`, a deploy's steps) asks
 *    once, and every later discovery in the run takes the same Gateway;
 *  - the checkout's pick, in `~/.everyapp/gateway-picks.json` keyed by the
 *    checkout (the nearest directory above the working directory holding
 *    `.git`, else the working directory): a later command there, at a
 *    terminal, takes it with a dim line saying so, unless it destroys
 *    something (`alwaysAsk`: `delete`, `db restore`, `setup`), where it is
 *    the preselected choice. --json and unattended runs never read it.
 *
 * The file is a convenience: unreadable or unwritable, it is ignored.
 */
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface GatewayPick {
  accountId: string;
  /** The Gateway's Worker: `every-app-gateway`, `every-app-gateway-<name>`. */
  worker: string;
}

interface Pickable {
  account: { id: string };
  names: { worker: string };
}

let pickedThisRun: GatewayPick | null = null;

/** The one of `candidates` that `pick` names, if any. */
export function pickedAmong<T extends Pickable>(candidates: readonly T[], pick: GatewayPick | null): T | null {
  if (!pick) return null;
  return candidates.find((g) => g.account.id === pick.accountId && g.names.worker === pick.worker) ?? null;
}

export function thisRunsPick(): GatewayPick | null {
  return pickedThisRun;
}

/** Record a pick for the rest of this run, and for the checkout. */
export async function rememberPick(gateway: Pickable, cwd: string = process.cwd()): Promise<void> {
  pickedThisRun = { accountId: gateway.account.id, worker: gateway.names.worker };
  try {
    const file = picksFile();
    const picks = await readPicks(file);
    picks[checkoutOf(cwd)] = { ...pickedThisRun, pickedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(picks, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A convenience only.
  }
}

/** The checkout's remembered pick, or null. */
export async function checkoutPick(cwd: string = process.cwd()): Promise<GatewayPick | null> {
  const entry = (await readPicks(picksFile()))[checkoutOf(cwd)];
  if (!entry || typeof entry.accountId !== "string" || typeof entry.worker !== "string") return null;
  return { accountId: entry.accountId, worker: entry.worker };
}

/** Tests: a new run, the checkout's pick kept. */
export function forgetThisRunsPickForTests(): void {
  pickedThisRun = null;
}

/** Tests: forget this run's pick and every checkout's. */
export function resetGatewayPicksForTests(): void {
  pickedThisRun = null;
  rmSync(picksFile(), { force: true });
}

function picksFile(): string {
  return path.join(os.homedir(), ".everyapp", "gateway-picks.json");
}

type Picks = Record<string, Partial<GatewayPick> & { pickedAt?: string }>;

async function readPicks(file: string): Promise<Picks> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Picks) : {};
  } catch {
    return {};
  }
}

/** The nearest directory at or above `cwd` holding `.git` (a worktree's is a file), else `cwd`. */
function checkoutOf(cwd: string): string {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}
