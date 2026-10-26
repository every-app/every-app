/**
 * The owner setup link: how a person gets the gateway's first account. The
 * CLI writes it straight into the gateway's D1 (`owner_setup_tokens`) with
 * the operator's Cloudflare credentials, and learns it was used by reading
 * the same row back: the gateway's claim creates the owner and their
 * membership, then consumes the link, and undoes both if anything fails.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { execa } from "execa";
import type { D1Database } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";

const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

interface SetupLink {
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

const OWNERS = `SELECT users.email AS email, organizations.name AS organization_name, organizations.id AS organization_id
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

/**
 * The gateway's first owner (of the oldest organization with one) and that
 * organization's id, the install organization's; null when nobody has
 * claimed the gateway yet.
 */
export async function readOwnerOrganization(
  db: D1Database,
): Promise<{ owner: GatewayOwner; organizationId: string } | null> {
  const [rows = []] = await db.run([
    {
      sql: `${OWNERS} ORDER BY organizations.created_at, organizations.id, members.created_at LIMIT 1`,
    },
  ]);
  const owner = toOwner(rows[0]);
  return owner ? { owner, organizationId: String(rows[0]!["organization_id"]) } : null;
}

/** The gateway's first owner (of the oldest organization with one), or null. */
export async function readOwner(db: D1Database): Promise<GatewayOwner | null> {
  return (await readOwnerOrganization(db))?.owner ?? null;
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
/** How long reads may keep failing on the network before the wait gives up. */
const NETWORK_GRACE_MS = 2 * 60 * 1000;

/**
 * Whether a failed read of the link's row is the network's (a Wi-Fi drop,
 * a laptop that slept, a reset connection), which the wait rides out,
 * rather than an answer from Cloudflare. cf reports Node's
 * `fetch failed` as an unknown error ("fetch failed Envelope Error").
 */
function isNetworkDrop(error: unknown): boolean {
  const message =
    error instanceof CfError
      ? error.kind === "unknown"
        ? error.message
        : ""
      : error instanceof TypeError
        ? error.message
        : "";
  return /fetch failed|Envelope Error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network/i.test(
    message,
  );
}

/**
 * Read the link's row every five seconds, for up to fifteen minutes, until
 * someone claims it or it is gone. Still `waiting` when time ran out.
 * Reads that fail on the network are retried; once they have failed for two
 * minutes in a row (or until the end of the wait), it stops with
 * OWNER_WAIT_NETWORK, which says that setup again picks up at the owner step.
 */
export async function waitForSetupLink({
  db,
  id,
  timeoutMs = OWNER_WAIT_MS,
  intervalMs = OWNER_POLL_MS,
  networkGraceMs = NETWORK_GRACE_MS,
  sleep = setTimeout,
  now = Date.now,
}: {
  db: D1Database;
  id: string;
  timeoutMs?: number;
  intervalMs?: number;
  networkGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<SetupLinkState> {
  const deadline = now() + timeoutMs;
  let failingSince: number | null = null;
  for (;;) {
    let state: SetupLinkState | null = null;
    try {
      state = await readSetupLink(db, id, now());
      failingSince = null;
    } catch (error) {
      if (!isNetworkDrop(error)) throw error;
      failingSince ??= now();
      if (now() - failingSince >= networkGraceMs || now() >= deadline) {
        throw ownerWaitNetwork(error);
      }
    }
    if (state && (state.status !== "waiting" || now() >= deadline)) return state;
    await sleep(intervalMs);
  }
}

/** The network dropped for good while setup waited for the owner. */
function ownerWaitNetwork(error: unknown): EveryAppError {
  const cause = (error as Error).message.split("\n")[0] ?? "";
  return new EveryAppError(
    "OWNER_WAIT_NETWORK",
    "The network dropped while waiting for the owner link\nThe Gateway is installed; only the owner account is left. If you created it in the browser meanwhile, setup finds it.",
    {
      retryable: true,
      rerun: thisCommand(),
      rerunNote: "once you're back online: it picks up at the owner step (with a new link if nobody used this one)",
      data: { cause },
    },
  );
}

/**
 * Whether a run may show an owner setup link, which makes whoever opens it
 * the gateway's owner: to a person at its terminal, or through the --json
 * events an agent on this machine hands on to one (`relayed`), but never
 * into CI or piped output, where it would sit in logs for anyone who can
 * read them.
 */
export function maySetupLinkBeShown({
  terminal = Boolean(process.stdout.isTTY),
  relayed = false,
}: {
  /** A person watches this run's terminal. */
  terminal?: boolean;
  /** The run's --json events go to an agent that hands the link on. */
  relayed?: boolean;
} = {}): boolean {
  if (process.env["CI"]) return false;
  return terminal || relayed;
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
