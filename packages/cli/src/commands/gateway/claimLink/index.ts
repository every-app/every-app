import chalk from "chalk";
import type { LocalContext } from "@/context";
import {
  getDefaultAccountId,
  getGatewayPublicUrl,
  requireCloudflareAuth,
} from "@/lib/cloudflare";
import { findGatewayDatabaseId } from "@/lib/cloudflare/gatewayD1";
import {
  gatewayHasOwner,
  mintSetupLink,
  presentSetupLink,
} from "@/lib/gateway/setup-link";
import { exitWithUpdateNotice } from "@/lib/version-check";

/**
 * Mint a fresh owner setup link for a gateway that has not been claimed yet
 * (the deploy's link was lost or expired). Cloudflare credentials for the
 * gateway's account are the proof of control; the previous unused link stops
 * working.
 */
export async function claimLink(this: LocalContext): Promise<void> {
  await requireCloudflareAuth();
  const accountId = await getDefaultAccountId();

  const databaseId = await findGatewayDatabaseId(accountId);
  if (!databaseId) {
    console.log(chalk.yellow("\nGateway not deployed\n"));
    console.log(chalk.dim("  Run: npx everyapp gateway deploy\n"));
    await exitWithUpdateNotice(1);
    return;
  }

  if (await gatewayHasOwner({ accountId, databaseId })) {
    console.log(chalk.yellow("\nThis gateway already has an owner\n"));
    console.log(
      chalk.dim(
        "  Setup links only create the first owner. Sign in, or ask an owner or admin to invite you.\n",
      ),
    );
    await exitWithUpdateNotice(1);
    return;
  }

  const gatewayUrl = await getGatewayPublicUrl(accountId);
  const link = await mintSetupLink({ accountId, databaseId, gatewayUrl });
  console.log();
  await presentSetupLink(link);
}
