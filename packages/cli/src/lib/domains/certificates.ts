/**
 * The certificates of the gateway's hostnames. Cloudflare issues each
 * Workers Custom Domain an advanced certificate pack listing the zone apex,
 * the hostname and `*.<hostname>` (the gateway's own, at the apex, lists the
 * apex and `*.<apex>`), next to the zone's Universal SSL packs (the apex and
 * `*.<apex>`), and keeps a pack when its domain is removed. `everyapp
 * delete` deletes a removed hostname's packs once the gateway no longer
 * publishes it, never one that would leave another name (the apex, above
 * all) without an active certificate, and `everyapp status` reads which
 * hostnames have an active one.
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

type CertificatePack = Awaited<ReturnType<typeof listCertificatePacks>>[number];

function isActive(pack: CertificatePack): boolean {
  return !pack.status || pack.status === "active";
}

function packHosts(pack: CertificatePack): string[] {
  return (pack.hosts ?? []).map((host) => host.toLowerCase());
}

/** Whether a certificate for `pattern` (a host, or `*.<parent>`) covers `host`. */
function covers(pattern: string, host: string): boolean {
  const lower = pattern.toLowerCase();
  if (lower === host) return true;
  if (!lower.startsWith("*.")) return false;
  const [, ...rest] = host.split(".");
  return rest.join(".") === lower.slice(2);
}

/**
 * Which of `hosts` have an active certificate in the zone, by Cloudflare's
 * certificate packs.
 */
export async function certificateStatus(
  cf: CfRunner,
  zoneId: string,
  hosts: readonly string[],
): Promise<Array<{ host: string; ready: boolean }>> {
  const active = (await listCertificatePacks(cf, zoneId)).filter(isActive);
  return hosts.map((host) => ({
    host,
    ready: active.some((pack) =>
      (pack.hosts ?? []).some((pattern) => covers(pattern, host.toLowerCase())),
    ),
  }));
}

/**
 * Which of the zone's packs to delete for the removed `hostname`: a pack
 * that lists the hostname itself, is not Universal SSL's (Cloudflare
 * manages those), and whose every other name, `*.<hostname>` aside, an
 * active pack that stays lists too. Listed, not merely matched by a
 * wildcard: the apex Cloudflare puts in each app's pack is listed by
 * Universal SSL's and the gateway's own, while a pack naming another app's
 * hostname stays even where `*.<apex>` would answer for it, since that
 * hostname's Custom Domain may be what the pack was issued for. Packs are taken in turn and a pack
 * chosen no longer counts, so two of the hostname's packs never vouch for
 * each other's apex.
 */
function packsToDelete(
  packs: readonly CertificatePack[],
  hostname: string,
): CertificatePack[] {
  const host = hostname.toLowerCase();
  const own = new Set([host, `*.${host}`]);
  const kept = [...packs];
  const chosen: CertificatePack[] = [];
  for (const pack of packs) {
    if (pack.type === "universal") continue;
    const names = packHosts(pack);
    if (!names.includes(host)) continue;
    const others = kept.filter((other) => other !== pack && isActive(other));
    const covered = names.every(
      (name) =>
        own.has(name) ||
        others.some((other) => packHosts(other).includes(name)),
    );
    if (!covered) continue;
    kept.splice(kept.indexOf(pack), 1);
    chosen.push(pack);
  }
  return chosen;
}

/**
 * Delete the removed `hostname`'s certificate packs (see `packsToDelete`);
 * returns their ids. A failure is a warning: the app is deleted either way,
 * and a stale certificate only sits in the zone's list.
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
    const packs = packsToDelete(await listCertificatePacks(cf, zoneId), hostname);
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
