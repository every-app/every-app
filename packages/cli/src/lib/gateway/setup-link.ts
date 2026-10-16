import chalk from "chalk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execa } from "execa";
import type { D1Database } from "@/lib/cf/d1";
import { writePendingClaim } from "./pendingClaims";

const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface SetupLink {
  url: string;
  expiresAt: Date;
  /**
   * The second secret, when asked for: never printed, never in the link,
   * it retrieves the owner's first deploy token once the link is claimed
   * (lib/gateway/autoLogin.ts).
   */
  cliSecret?: string;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Whether the gateway has been claimed, read straight from its D1. */
export async function gatewayHasOwner(db: D1Database): Promise<boolean> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT 1 AS found FROM members WHERE role = ? LIMIT 1",
      params: ["owner"],
    },
  ]);
  return rows.length > 0;
}

/**
 * Mint a one-time owner setup link: `<gateway>/setup#token=est_…`.
 *
 * Only the SHA-256 of the secret is written to the gateway's D1 (with the
 * deployer's Cloudflare credentials, through `cf d1 query`), in the same
 * request that expires any earlier unused link. The secret lives in the URL
 * fragment, so it never reaches the gateway's logs or a Referer header, and
 * it is never on a command line: the statements travel in a private file.
 *
 * With `withCliSecret` (a gateway whose `owner_setup_tokens` has a
 * `cli_secret_hash` column), a second secret (`ecs_…`) is stored the same
 * way, for this CLI to log itself in with once the link is claimed.
 */
export async function mintSetupLink({
  db,
  gatewayUrl,
  withCliSecret = false,
  now = Date.now(),
}: {
  db: D1Database;
  gatewayUrl: string;
  withCliSecret?: boolean;
  now?: number;
}): Promise<SetupLink> {
  const token = `est_${randomBytes(32).toString("base64url")}`;
  const cliSecret = withCliSecret
    ? `ecs_${randomBytes(32).toString("base64url")}`
    : undefined;
  const expiresAt = now + SETUP_LINK_TTL_MS;

  await db.run([
    {
      sql: "UPDATE owner_setup_tokens SET expires_at = ?1 WHERE kind = 'claim' AND consumed_at IS NULL AND expires_at > ?1",
      params: [now],
    },
    cliSecret
      ? {
          sql: "INSERT INTO owner_setup_tokens (id, kind, token_hash, cli_secret_hash, expires_at) VALUES (?, 'claim', ?, ?, ?)",
          params: [randomUUID(), sha256(token), sha256(cliSecret), expiresAt],
        }
      : {
          sql: "INSERT INTO owner_setup_tokens (id, kind, token_hash, expires_at) VALUES (?, 'claim', ?, ?)",
          params: [randomUUID(), sha256(token), expiresAt],
        },
  ]);

  return {
    url: `${gatewayUrl.replace(/\/$/, "")}/setup#token=${token}`,
    expiresAt: new Date(expiresAt),
    ...(cliSecret ? { cliSecret } : {}),
  };
}

/**
 * Whether the gateway's database takes a CLI secret with a setup link (its
 * `owner_setup_tokens` has a `cli_secret_hash` column), so this CLI can log
 * itself in once the link is claimed.
 */
async function storesCliSecrets(db: D1Database): Promise<boolean> {
  const [columns = []] = await db.run([
    { sql: `PRAGMA table_info("owner_setup_tokens")` },
  ]);
  return columns.some((column) => column["name"] === "cli_secret_hash");
}

/**
 * Mint a setup link for this machine's operator: with a CLI secret when
 * the gateway takes one, remembered as a pending claim, so that
 * `everyapp login --resume` logs in once someone claims the link.
 */
export async function mintOperatorSetupLink({
  db,
  gatewayUrl,
}: {
  db: D1Database;
  gatewayUrl: string;
}): Promise<SetupLink> {
  const link = await mintSetupLink({
    db,
    gatewayUrl,
    withCliSecret: await storesCliSecrets(db),
  });
  if (link.cliSecret) {
    await writePendingClaim({
      gatewayUrl,
      url: link.url,
      cliSecret: link.cliSecret,
      expiresAt: link.expiresAt.toISOString(),
    });
  }
  return link;
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
  onUnattended = () =>
    console.log(
      chalk.yellow(
        "\nGateway is unclaimed: run `everyapp gateway claim-link` on your machine to create the owner account.\n",
      ),
    ),
}: {
  db: D1Database;
  gatewayUrl: string;
  printSetupLink?: boolean;
  onUnattended?: () => void;
}): Promise<SetupLink | null> {
  if (await gatewayHasOwner(db)) return null;

  if (!maySetupLinkBeShown({ printSetupLink })) {
    onUnattended();
    return null;
  }
  return mintOperatorSetupLink({ db, gatewayUrl });
}

/** Print the link and, in an interactive terminal, open it. */
export async function presentSetupLink(link: SetupLink): Promise<void> {
  console.log(
    chalk.bold("Create the owner account with this one-time setup link:\n"),
  );
  console.log(`  ${chalk.cyan(link.url)}\n`);
  console.log(
    chalk.dim(
      `  It works once and expires ${link.expiresAt.toLocaleString()}. Treat it like a password.\n` +
        (link.cliSecret
          ? "  Once the owner account exists, `everyapp login --resume` logs this CLI in.\n"
          : "") +
        "  Lost it? Run `everyapp gateway claim-link` for a new one.\n",
    ),
  );

  if (isInteractiveRun()) {
    await openInBrowser(link.url);
  }
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
