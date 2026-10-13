/**
 * Removing a deleted app's certificate. Cloudflare issues each Workers
 * Custom Domain its own certificate pack and keeps it when the domain is
 * removed, so `everyapp app delete` deletes the packs that covered only the
 * app's hostname, once the gateway no longer publishes it. Never a pack
 * that also covers another name.
 */
import { CfError } from "@/lib/cf/errors";
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
import { CertificatePackListOutput } from "@/lib/cf/schemas";
import type { EventSink } from "@/lib/output/events";

const PACK_PAGE_SIZE = 50;
const MAX_PACK_PAGES = 20;

async function listCertificatePacks(cf: CfRunner, zoneId: string) {
  const packs = [];
  for (let page = 1; page <= MAX_PACK_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "ssl",
          "certificate-packs",
          "list",
          "-z",
          zoneId,
          "--per-page",
          String(PACK_PAGE_SIZE),
          "--page",
          String(page),
        ],
      },
      CertificatePackListOutput,
    );
    packs.push(...batch);
    if (batch.length < PACK_PAGE_SIZE) break;
  }
  return packs;
}

/**
 * Delete the certificate packs that cover exactly `hostname`; returns their
 * ids. A failure is a warning: the app is deleted either way, and a stale
 * certificate only sits in the zone's list.
 */
export async function deleteHostCertificates({
  cf,
  out,
  step,
  zoneId,
  hostname,
}: {
  cf: CfRunner;
  out: EventSink;
  step: string;
  zoneId: string;
  hostname: string;
}): Promise<string[]> {
  const deleted: string[] = [];
  try {
    const packs = (await listCertificatePacks(cf, zoneId)).filter((pack) => {
      const hosts = (pack.hosts ?? []).map((host) => host.toLowerCase());
      return hosts.length === 1 && hosts[0] === hostname;
    });
    for (const pack of packs) {
      try {
        // cf asks before deleting, and answers no itself when no one can.
        await cf.run({
          plane: "account",
          mode: "json",
          args: ["ssl", "certificate-packs", "delete", pack.id, "-z", zoneId, "--force"],
        });
        deleted.push(pack.id);
      } catch (error) {
        if (!(error instanceof CfError && error.kind === "not_found")) throw error;
      }
    }
  } catch (error) {
    out.emit({
      type: "warning",
      code: "CERT_CLEANUP_FAILED",
      step,
      message: `Couldn't remove ${hostname}'s certificate (${error instanceof Error ? error.message : String(error)}). It serves nothing now; delete it in the Cloudflare dashboard (SSL/TLS → Edge Certificates) if you like.`,
    });
    return deleted;
  }
  if (deleted.length > 0) {
    out.emit({
      type: "progress",
      step,
      message: `Removed ${hostname}'s certificate.`,
      data: { certificatePacks: deleted },
    });
  }
  return deleted;
}
