import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import { readInstall } from "@/lib/gateway/install";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import {
  describeSetupLink,
  gatewayHasOwner,
  mintSetupLink,
  openSetupLinkHere,
  type SetupLink,
} from "@/lib/gateway/setup-link";
import {
  connectToAccount,
  eventSink,
  rememberedInstall,
  runReported,
} from "../shared";

interface ClaimLinkFlags {
  "account-id"?: string;
  domain?: string;
}

/**
 * Mint a fresh owner setup link for a gateway that has not been claimed yet
 * (the deploy's link was lost or expired). Cloudflare credentials for the
 * gateway's account are the proof of control; the previous unused link stops
 * working.
 */
export async function claimLink(
  this: LocalContext,
  flags: ClaimLinkFlags = {},
): Promise<void> {
  const out = eventSink();
  await runReported(out, async () => {
    const domain = normalizeHostname(flags.domain);
    const cached = await rememberedInstall(domain);
    const { cf } = await connectToAccount({
      accountId: flags["account-id"],
      remembered: cached?.accountId,
    });
    const link = await mintClaimLink(cf, domain ?? cached?.gatewayHost);
    out.emit({
      type: "done",
      message: describeSetupLink(link),
      data: { url: link.url, expiresAt: link.expiresAt.toISOString() },
    });
    await openSetupLinkHere(link);
  });
}

/** A new owner setup link for the unclaimed gateway in `cf`'s account. */
export async function mintClaimLink(
  cf: CfRunner,
  fallbackHost: string | undefined,
): Promise<SetupLink> {
  const databaseId = await findGatewayDatabase(cf);
  if (!databaseId) {
    throw new EveryAppError(
      "GATEWAY_NOT_DEPLOYED",
      "No gateway is deployed in this Cloudflare account. Run: everyapp gateway deploy --domain <domain>",
    );
  }
  const db = cfD1Database(cf, databaseId);
  if (await gatewayHasOwner(db)) {
    throw new EveryAppError(
      "GATEWAY_CLAIMED",
      "This gateway already has an owner. Setup links only create the first owner: sign in, or ask an owner or admin to invite you.",
    );
  }
  const gatewayHost = (await readInstall(db))?.gatewayHost ?? fallbackHost;
  if (!gatewayHost) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      "Which gateway? Pass its domain: everyapp gateway claim-link --domain <domain>",
    );
  }
  return mintSetupLink({ db, gatewayUrl: `https://${gatewayHost}` });
}
