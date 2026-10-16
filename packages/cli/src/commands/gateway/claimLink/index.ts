import type { LocalContext } from "@/context";
import type { D1Database } from "@/lib/cf/d1";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import type { InstallRecord } from "@/lib/gateway/install";
import {
  describeSetupLink,
  gatewayHasOwner,
  mintSetupLink,
  openSetupLinkHere,
  type SetupLink,
} from "@/lib/gateway/setup-link";
import { eventSink, existingGateway, runReported } from "../shared";

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
    const { db, install } = await existingGateway({
      accountId: flags["account-id"],
    });
    const link = await mintClaimLink(db, install, normalizeHostname(flags.domain));
    out.emit({
      type: "done",
      message: describeSetupLink(link),
      data: { url: link.url, expiresAt: link.expiresAt.toISOString() },
    });
    await openSetupLinkHere(link);
  });
}

/** A new owner setup link for an unclaimed Gateway, at its recorded host. */
export async function mintClaimLink(
  db: D1Database,
  install: InstallRecord | null,
  fallbackHost: string | undefined,
): Promise<SetupLink> {
  if (await gatewayHasOwner(db)) {
    throw new EveryAppError(
      "GATEWAY_CLAIMED",
      "This gateway already has an owner. Setup links only create the first owner: sign in, or ask an owner or admin to invite you.",
    );
  }
  const gatewayHost = install?.gatewayHost ?? fallbackHost;
  if (!gatewayHost) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      "Which gateway? Pass its domain: everyapp gateway claim-link --domain <domain>",
    );
  }
  return mintSetupLink({ db, gatewayUrl: `https://${gatewayHost}` });
}
