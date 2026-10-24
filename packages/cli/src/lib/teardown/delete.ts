/**
 * Carrying a teardown plan out, kind by kind, in an order that never
 * deletes what something still binds: Access first (the applications,
 * then the policy they used), Email Routing (no rule names a Worker that
 * is gone), Workflows, the Workers (apps and helpers, the Gateway's last;
 * each deleted with its references, since they bind each other), the
 * hostnames' certificate packs (Cloudflare removes a hostname's pack with
 * its Custom Domain, so a refusal for one it no longer lists is counted as
 * removed), the apps' D1, KV, R2, Hyperdrive, the DNS records left at our
 * names once the Custom Domains went with their Workers, and last of all
 * the Gateway's D1: it is where the inventory reads the hostnames, so
 * while a DNS record of theirs is kept it stays too, and a second run
 * finds the record again. A failure on one item is a warning and the item
 * goes to `kept`, with where to delete it by hand; the run goes on.
 */
import { deleteAccessApplication, deleteAccessPolicy } from "@/lib/cf/access";
import {
  deleteEmailRoutingRule,
  disableEmailRouting,
  updateEmailRoutingCatchAll,
  type EmailRoutingRuleBody,
} from "@/lib/cf/emailRouting";
import { isCfError } from "@/lib/cf/errors";
import { deleteHyperdrive } from "@/lib/cf/hyperdrive";
import { deleteR2Bucket } from "@/lib/cf/r2";
import { deleteD1, deleteKv } from "@/lib/cf/resources";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorker } from "@/lib/cf/workers";
import { deleteWorkflowIfExists } from "@/lib/cf/workflows";
import { deleteCertificatePack, isPackGone, listCertificatePacks } from "@/lib/domains/certificates";
import { deleteDnsRecord, dnsRecordsAt } from "@/lib/domains/records";
import { errorMessage } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { plural } from "@/lib/output/text";
import { TeardownCode } from "./guards";
import {
  describe,
  emailChanges,
  isCustomDomainRecord,
  isEmailRoutingRecord,
  KINDS,
  PLACES,
  type Kind,
  type TeardownPlan,
} from "./plan";

/** Something the run couldn't delete, and where to. */
interface Kept {
  kind: Kind;
  described: string;
  /** Where in the Cloudflare dashboard. */
  place: string;
  /** What Cloudflare said. */
  reason: string;
}

interface TeardownResult {
  removed: string[];
  kept: Kept[];
}

/**
 * What a deletion answers when Cloudflare had already removed the item
 * along with another (a certificate pack with its Custom Domain): counted
 * as removed, under this description.
 */
interface RemovedAs {
  removedAs: string;
}

const isRemovedAs = (value: unknown): value is RemovedAs =>
  typeof value === "object" && value !== null && "removedAs" in value;

/** What a catch-all goes back to: dropping mail, as a zone starts. */
const DROP_CATCH_ALL: EmailRoutingRuleBody = {
  name: "",
  enabled: false,
  matchers: [{ type: "all" }],
  actions: [{ type: "drop" }],
};

const STEP = "teardown.delete";

/**
 * How long to wait before looking a second time for a pack Cloudflare
 * refused but still listed as active: live, a hostname's pack was gone "a
 * minute later", and the first look comes right after the refusal.
 */
const PACK_SECOND_LOOK_MS = 5_000;

export async function executeTeardown({
  cf,
  plan,
  out,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  cf: CfRunner;
  plan: TeardownPlan;
  out: EventSink;
  /** Waits before the second look at a refused certificate pack (tests answer at once). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<TeardownResult> {
  const removed: string[] = [];
  const kept: Kept[] = [];

  /**
   * One item: deleted, gone already (nothing to say: a thrown not_found,
   * or a wrapper that answers `false` for one), removed under another
   * description (`RemovedAs`), or kept with a warning.
   */
  const attempt = async (kind: Kind, described: string, deletion: () => Promise<unknown>): Promise<void> => {
    try {
      const result = await deletion();
      if (result === false) return;
      removed.push(isRemovedAs(result) ? result.removedAs : described);
    } catch (error) {
      if (isCfError(error, "not_found")) return;
      const reason = errorMessage(error).split("\n")[0] ?? "";
      kept.push({ kind, described, place: PLACES[kind], reason });
      out.emit({
        type: "warning",
        code: TeardownCode.DeleteFailed,
        step: STEP,
        message: `Couldn't delete the ${described}\n${reason}`,
        data: { kind, described, reason, fix: `delete it in the Cloudflare dashboard (${PLACES[kind]})` },
      });
    }
  };

  /** One kind, as one step: skipped when the plan has nothing of it. */
  const kindStep = async (kind: Kind, count: number, items: () => Promise<void>): Promise<void> => {
    if (count === 0) return;
    const [, one, many] = KINDS.find(([name]) => name === kind)!;
    const label = count === 1 ? one : many;
    const before = removed.length;
    const keptBefore = kept.length;
    out.emit({ type: "step", step: STEP, status: "start", message: `Deleting ${count} ${label}...`, data: { kind, count } });
    await items();
    const done = removed.length - before;
    const left = kept.length - keptBefore;
    out.emit({
      type: "step",
      step: STEP,
      status: "ok",
      message:
        left === 0
          ? `Deleted ${done} ${done === 1 ? one : many}`
          : `Deleted ${done} ${done === 1 ? one : many}; kept ${left}`,
      data: { kind, removed: removed.slice(before), kept: kept.slice(keptBefore).map((item) => item.described) },
    });
  };

  // 1. Access: the applications, then the policy they used.
  await kindStep("access", plan.access.applications.length + (plan.access.policy ? 1 : 0), async () => {
    for (const application of plan.access.applications) {
      await attempt("access", describe.application(application.name), () => deleteAccessApplication(cf, application.id));
    }
    if (plan.access.policy) {
      const { id, name } = plan.access.policy;
      await attempt("access", describe.policy(name), () => deleteAccessPolicy(cf, id));
    }
  });

  // 2. Email Routing: the rules, the catch-all back to drop, routing off.
  await kindStep("email", emailChanges(plan.email), async () => {
    for (const zone of plan.email) {
      for (const rule of zone.rules) {
        await attempt("email", describe.rule(rule.address, zone.zoneName), () =>
          deleteEmailRoutingRule(cf, zone.zoneId, rule.id),
        );
      }
      if (zone.catchAllWorker) {
        await attempt("email", describe.catchAll(zone.zoneName), () =>
          updateEmailRoutingCatchAll(cf, zone.zoneId, DROP_CATCH_ALL),
        );
      }
      if (zone.disable) {
        await attempt("email", describe.routing(zone.zoneName), () => disableEmailRouting(cf, zone.zoneId));
      }
    }
  });

  // 3. Workflows, before the Workers that run them.
  await kindStep("workflows", plan.workflows.length, async () => {
    for (const name of plan.workflows) {
      await attempt("workflows", describe.workflow(name), () => deleteWorkflowIfExists(cf, name));
    }
  });

  // 4. Workers: apps, their helpers, the Gateway's last, each with its
  // references (the Gateway binds every app and every app the Gateway, and
  // all of them go). Custom Domains go with each.
  await kindStep("workers", plan.workers.length, async () => {
    for (const worker of plan.workers) {
      await attempt("workers", describe.worker(worker.name), () =>
        deleteWorker(cf, worker.name, { withReferences: true }),
      );
    }
  });

  // 5. The hostnames' certificate packs. Cloudflare removes a hostname's
  // pack with its Custom Domain, which went with its Worker a step ago, and
  // refuses to delete a pack on its way out (`[1406] Bad response
  // certificate service`, seen live): a refusal is checked against the
  // zone's list, read with every status (the default listing shows only
  // active packs, which would hide the one on its way out and read it as
  // gone). A pack no longer listed, or in a deleting status, is counted as
  // removed; one still listed as it was gets a second look after a short
  // wait, since the first comes right after the refusal. Only a pack still
  // listed then is kept.
  await kindStep("certificates", plan.certificates.length, async () => {
    for (const pack of plan.certificates) {
      const described = describe.pack(pack.packId, pack.hostname);
      await attempt("certificates", described, async (): Promise<RemovedAs | undefined> => {
        try {
          await deleteCertificatePack(cf, pack.zoneId, pack.packId);
          return undefined;
        } catch (error) {
          if (isCfError(error, "not_found")) throw error;
          const reason = errorMessage(error).split("\n")[0] ?? "";
          const listedNow = () => listCertificatePacks(cf, pack.zoneId, { allStatuses: true });
          let listed = await listedNow().catch(() => null);
          if (listed && !isPackGone(listed, pack.packId)) {
            await sleep(PACK_SECOND_LOOK_MS);
            listed = await listedNow().catch(() => listed);
          }
          if (listed && isPackGone(listed, pack.packId)) {
            return { removedAs: `${described} (gone with its Custom Domain)` };
          }
          throw new Error(
            `${reason}. Cloudflare removes a hostname's pack with its Custom Domain, so it is likely on its way out; if the zone still lists it, finish it in the dashboard`,
          );
        }
      });
    }
  });

  // 6. D1: the apps' databases. The Gateway's goes last of all (11).
  const gatewayDatabase = plan.d1.find((database) => database.id === plan.gateway?.databaseId) ?? null;
  const appDatabases = plan.d1.filter((database) => database !== gatewayDatabase);
  await kindStep("d1", appDatabases.length, async () => {
    for (const database of appDatabases) {
      await attempt("d1", describe.d1(database.name), () => deleteD1(cf, database.id));
    }
  });

  // 7. KV.
  await kindStep("kv", plan.kv.length, async () => {
    for (const namespace of plan.kv) {
      await attempt("kv", describe.kv(namespace.title), () => deleteKv(cf, namespace.id));
    }
  });

  // 8. R2: a bucket with objects is refused, and kept.
  await kindStep("r2", plan.r2.length, async () => {
    for (const name of plan.r2) {
      await attempt("r2", describe.r2(name), () => deleteR2Bucket(cf, name));
    }
  });

  // 9. Hyperdrive configs (the Postgres databases they connect to are never touched).
  await kindStep("hyperdrive", plan.hyperdrive.length, async () => {
    for (const config of plan.hyperdrive) {
      await attempt("hyperdrive", describe.hyperdrive(config.name), () => deleteHyperdrive(cf, config.id));
    }
  });

  // 10. DNS left at exactly our names, read again now that the Workers
  // (and their Custom Domains' records) are gone: only a Custom Domain's
  // kinds of record (A, AAAA, CNAME). Everything else there is someone
  // else's; Email Routing's records stay its own: off, Cloudflare removed
  // them; on, something else routes mail.
  const leftovers: Array<{ zoneId: string; name: string; id: string; type: string }> = [];
  for (const planned of plan.dns) {
    try {
      for (const record of await dnsRecordsAt(cf, planned.zoneId, planned.name)) {
        if (!isCustomDomainRecord(record)) continue;
        if (isEmailRoutingRecord({ type: record.type, content: record.content ?? null })) continue;
        leftovers.push({ zoneId: planned.zoneId, name: planned.name, id: record.id, type: record.type });
      }
    } catch (error) {
      out.emit({
        type: "warning",
        code: TeardownCode.DeleteFailed,
        step: STEP,
        message: `Couldn't read the DNS records at ${planned.name}\n${errorMessage(error).split("\n")[0]}`,
        data: { kind: "dns", name: planned.name, fix: `check them in the Cloudflare dashboard (${PLACES.dns})` },
      });
    }
  }
  await kindStep("dns", leftovers.length, async () => {
    for (const record of leftovers) {
      await attempt("dns", describe.record(record.type, record.name), () =>
        deleteDnsRecord(cf, record.zoneId, record.id),
      );
    }
  });

  // 11. The Gateway's D1, last of all: the inventory reads the hostnames
  // from it, so while a DNS record of theirs is kept, it stays too, and the
  // next run finds the record again (the Custom Domains that also named
  // them went with the Workers). A kept certificate pack never holds it:
  // Cloudflare removes a hostname's pack with its Custom Domain, so a pack
  // it refused is on its way out, and holding the D1 for one would leave a
  // row the next install resumes from instead of starting fresh.
  await kindStep("d1", gatewayDatabase ? 1 : 0, async () => {
    if (!gatewayDatabase) return;
    const byHostname = kept.filter((item) => item.kind === "dns");
    if (byHostname.length > 0) {
      kept.push({
        kind: "d1",
        described: describe.d1(gatewayDatabase.name),
        place: PLACES.d1,
        reason: `kept on purpose: the next run reads the hostnames of the ${plural(byHostname.length, "kept DNS record")} above from it`,
      });
      return;
    }
    await attempt("d1", describe.d1(gatewayDatabase.name), () => deleteD1(cf, gatewayDatabase.id));
  });

  return { removed, kept };
}
