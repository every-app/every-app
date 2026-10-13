import chalk from "chalk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execa } from "execa";
import { queryGatewayD1 } from "@/lib/cloudflare/gatewayD1";

const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

interface GatewayDatabase {
  accountId: string;
  databaseId: string;
}

export interface SetupLink {
  url: string;
  expiresAt: Date;
}

/** Whether the gateway has been claimed, read straight from its D1. */
export async function gatewayHasOwner({
  accountId,
  databaseId,
}: GatewayDatabase): Promise<boolean> {
  const rows = await queryGatewayD1(
    accountId,
    databaseId,
    "SELECT 1 AS found FROM members WHERE role = ? LIMIT 1",
    ["owner"],
  );
  return rows.length > 0;
}

/**
 * Mint a one-time owner setup link: `<gateway>/setup#token=est_…`.
 *
 * Only the SHA-256 of the secret is written to the gateway's D1 (with the
 * deployer's Cloudflare credentials), and any earlier unused link is expired
 * first. The secret lives in the URL fragment, so it never reaches the
 * gateway's logs or a Referer header.
 */
export async function mintSetupLink({
  accountId,
  databaseId,
  gatewayUrl,
  now = Date.now(),
}: GatewayDatabase & { gatewayUrl: string; now?: number }): Promise<SetupLink> {
  const token = `est_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = now + SETUP_LINK_TTL_MS;

  await queryGatewayD1(
    accountId,
    databaseId,
    "UPDATE owner_setup_tokens SET expires_at = ? WHERE kind = 'claim' AND consumed_at IS NULL",
    [now],
  );
  await queryGatewayD1(
    accountId,
    databaseId,
    "INSERT INTO owner_setup_tokens (id, kind, token_hash, expires_at) VALUES (?, 'claim', ?, ?)",
    [randomUUID(), tokenHash, expiresAt],
  );

  return {
    url: `${gatewayUrl.replace(/\/$/, "")}/setup#token=${token}`,
    expiresAt: new Date(expiresAt),
  };
}

/** Whether a person is watching this run: a terminal, and not CI. */
function isInteractiveRun(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env["CI"];
}

/**
 * The setup link a deploy should show, or null: the gateway already has an
 * owner, or the deploy runs unattended (CI, output piped to a log), where the
 * link would sit in build logs for anyone who can read them. Then no link is
 * minted (an earlier unused one keeps working) and the deploy says how to
 * get one, unless `printSetupLink` asks for it anyway.
 */
export async function setupLinkForDeploy({
  accountId,
  databaseId,
  gatewayUrl,
  printSetupLink = false,
}: GatewayDatabase & {
  gatewayUrl: string;
  printSetupLink?: boolean;
}): Promise<SetupLink | null> {
  if (await gatewayHasOwner({ accountId, databaseId })) return null;

  if (!printSetupLink && !isInteractiveRun()) {
    console.log(
      chalk.yellow(
        "\nGateway is unclaimed: run `npx everyapp gateway claim-link` on your machine to create the owner account.\n",
      ),
    );
    return null;
  }
  return mintSetupLink({ accountId, databaseId, gatewayUrl });
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
        "  Lost it? Run `npx everyapp gateway claim-link` for a new one.\n",
    ),
  );

  if (isInteractiveRun()) {
    await openInBrowser(link.url);
  }
}

async function openInBrowser(url: string): Promise<void> {
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
