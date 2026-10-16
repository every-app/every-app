/**
 * The owner setup link: how a person gets the gateway's first account. The
 * CLI writes it straight into the gateway's D1 (`owner_setup_tokens`) with
 * the operator's Cloudflare credentials, and learns it was used by reading
 * the same row back: the gateway's claim creates the owner and their
 * membership, then consumes the link, and undoes both if anything fails.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execa } from "execa";
import type { D1Database } from "@/lib/cf/d1";

const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface SetupLink {
  /** The `owner_setup_tokens` row, to watch for the claim. */
  id: string;
  url: string;
  expiresAt: Date;
  /** An earlier link nobody used stopped working with this one. */
  replaced: boolean;
}

/** Who owns the gateway, and the organization they own. */
export interface GatewayOwner {
  email: string;
  organizationName: string;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Whether the gateway has been claimed, read straight from its D1. */
export async function gatewayHasOwner(db: D1Database): Promise<boolean> {
  return (await readOwner(db)) !== null;
}

const OWNERS = `SELECT users.email AS email, organizations.name AS organization_name
FROM members
JOIN users ON users.id = members.user_id
JOIN organizations ON organizations.id = members.organization_id
WHERE members.role = 'owner'`;

function toOwner(row: Record<string, unknown> | undefined): GatewayOwner | null {
  if (!row || typeof row["email"] !== "string") return null;
  return {
    email: row["email"],
    organizationName: String(row["organization_name"] ?? ""),
  };
}

/** The gateway's first owner (of the oldest organization with one), or null. */
export async function readOwner(db: D1Database): Promise<GatewayOwner | null> {
  const [rows = []] = await db.run([
    {
      sql: `${OWNERS} ORDER BY organizations.created_at, organizations.id, members.created_at LIMIT 1`,
    },
  ]);
  return toOwner(rows[0]);
}

/**
 * Mint a one-time owner setup link: `<gateway>/setup#token=est_…`.
 *
 * Only the SHA-256 of the secret is written to the gateway's D1 (with the
 * deployer's Cloudflare credentials, through `cf d1 query`), in the same
 * request that expires any earlier unused link. The secret lives in the URL
 * fragment, so it never reaches the gateway's logs or a Referer header, and
 * it is never on a command line: the statements travel in a private file.
 */
export async function mintSetupLink({
  db,
  gatewayUrl,
  now = Date.now(),
}: {
  db: D1Database;
  gatewayUrl: string;
  now?: number;
}): Promise<SetupLink> {
  const token = `est_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const expiresAt = now + SETUP_LINK_TTL_MS;

  const [live = []] = await db.run([
    {
      sql: "SELECT id FROM owner_setup_tokens WHERE kind = 'claim' AND consumed_at IS NULL AND expires_at > ?1",
      params: [now],
    },
    {
      sql: "UPDATE owner_setup_tokens SET expires_at = ?1 WHERE kind = 'claim' AND consumed_at IS NULL AND expires_at > ?1",
      params: [now],
    },
    {
      sql: "INSERT INTO owner_setup_tokens (id, kind, token_hash, expires_at) VALUES (?, 'claim', ?, ?)",
      params: [id, sha256(token), expiresAt],
    },
  ]);

  return {
    id,
    url: `${gatewayUrl.replace(/\/$/, "")}/setup#token=${token}`,
    expiresAt: new Date(expiresAt),
    replaced: live.length > 0,
  };
}

/** A setup link this run minted, as its row in D1 says. */
type SetupLinkState =
  /** Nobody has used it yet. */
  | { status: "waiting" }
  /** It made its owner. */
  | { status: "claimed"; owner: GatewayOwner | null }
  /** It expired, or a newer link replaced it, before anyone used it. */
  | { status: "gone" };

export async function readSetupLink(
  db: D1Database,
  id: string,
  now = Date.now(),
): Promise<SetupLinkState> {
  const [links = [], owners = []] = await db.run([
    {
      sql: "SELECT consumed_at, expires_at FROM owner_setup_tokens WHERE id = ?",
      params: [id],
    },
    // The user the claim made, with the organization it made them owner of.
    {
      sql: `${OWNERS} AND members.user_id = (SELECT consumed_by FROM owner_setup_tokens WHERE id = ?) LIMIT 1`,
      params: [id],
    },
  ]);
  const link = links[0];
  if (link && link["consumed_at"] !== null && link["consumed_at"] !== undefined) {
    return { status: "claimed", owner: toOwner(owners[0]) };
  }
  if (!link || Number(link["expires_at"]) <= now) return { status: "gone" };
  return { status: "waiting" };
}

const OWNER_WAIT_MS = 15 * 60 * 1000;
const OWNER_POLL_MS = 5_000;

/**
 * Read the link's row every five seconds, for up to fifteen minutes, until
 * someone claims it or it is gone. Still `waiting` when time ran out.
 */
export async function waitForSetupLink({
  db,
  id,
  timeoutMs = OWNER_WAIT_MS,
  intervalMs = OWNER_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  db: D1Database;
  id: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<SetupLinkState> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = await readSetupLink(db, id, now());
    if (state.status !== "waiting" || now() >= deadline) return state;
    await sleep(intervalMs);
  }
}

/** Whether a person is watching this run: a terminal, and not CI. */
function isInteractiveRun(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env["CI"];
}

/**
 * Whether a run may show an owner setup link, which makes whoever opens it
 * the gateway's owner: to a person at its terminal, or through the --json
 * events an agent on this machine hands on to one (`relayed`), but never
 * into CI or piped output, where it would sit in logs for anyone who can
 * read them, unless `printSetupLink` (`--printSetupLink`) asks for it.
 */
export function maySetupLinkBeShown({
  printSetupLink = false,
  terminal = Boolean(process.stdout.isTTY),
  relayed = false,
}: {
  printSetupLink?: boolean;
  /** A person watches this run's terminal. */
  terminal?: boolean;
  /** The run's --json events go to an agent that hands the link on. */
  relayed?: boolean;
} = {}): boolean {
  if (printSetupLink) return true;
  if (process.env["CI"]) return false;
  return terminal || relayed;
}

/**
 * The setup link a deploy should show, or null: the gateway already has an
 * owner, or the deploy runs unattended (CI, output piped to a log), where the
 * link would sit in build logs for anyone who can read them. Then no link is
 * minted (an earlier unused one keeps working) and `onUnattended` says how
 * to get one, unless `printSetupLink` asks for it anyway.
 */
export async function setupLinkForDeploy({
  db,
  gatewayUrl,
  printSetupLink = false,
  onUnattended,
}: {
  db: D1Database;
  gatewayUrl: string;
  printSetupLink?: boolean;
  onUnattended: () => void;
}): Promise<SetupLink | null> {
  if (await gatewayHasOwner(db)) return null;

  if (!maySetupLinkBeShown({ printSetupLink })) {
    onUnattended();
    return null;
  }
  return mintSetupLink({ db, gatewayUrl });
}

/** The link as a person reads it: what it does, the link, how long it works. */
export function describeSetupLink(link: SetupLink): string {
  return [
    "Create the owner account with this one-time setup link:",
    `  ${link.url}`,
    `It works once and expires ${link.expiresAt.toLocaleString()}. Treat it like a password. Lost it? Run \`everyapp gateway claim-link\` for a new one.`,
  ].join("\n");
}

/** Open the link in this machine's browser, when a person watches the run. */
export async function openSetupLinkHere(link: SetupLink): Promise<void> {
  if (isInteractiveRun()) await openInBrowser(link.url);
}

export async function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    await execa(command, args, { stdio: "ignore" });
  } catch {
    // Printing the link is enough; a missing opener is not an error.
  }
}
