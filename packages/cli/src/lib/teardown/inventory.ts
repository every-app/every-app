/**
 * What Every App created in one Cloudflare account, read and never
 * written: the Gateway's D1 (its install row, `apps` rows and the
 * resources each app recorded), then every kind of resource by name
 * (`every-*`), our Workers' queue consumers, the Access applications and policy, the Email Routing rules
 * that send mail to our Workers, the certificate packs of our hostnames
 * and the Custom Domain records (A, AAAA, CNAME) at exactly those names.
 * A missing Gateway D1 or table is fine: the name scan still runs, so a
 * second run finds what a first one left; so is one kind that can't be
 * listed (a warning, and the kind is said kept). A service the account
 * never enabled (Access, R2: Cloudflare answers 403 with its "not enabled"
 * code) holds nothing of ours: a `teardown.found` step says so and skips
 * it, no warning. Each kind goes out as a `teardown.found` step with its
 * count.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { APPS_APPLICATION_NAME, GATEWAY_APPLICATION_NAME, POLICY_NAME } from "@/commands/access/index";
import { findAccessApplications, type AccessScope } from "@/lib/access/plan";
import { readAllRecordedResources } from "@/lib/app/ownership";
import {
  getAccessOrganization,
  listAccessApplications,
  listAccessPolicies,
  type AccessApplication,
} from "@/lib/cf/access";
import { cfD1Database } from "@/lib/cf/d1";
import { isCfError, isServiceNotEnabled } from "@/lib/cf/errors";
import {
  getEmailRoutingCatchAll,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  ruleAddress,
  ruleWorker,
} from "@/lib/cf/emailRouting";
import { listHyperdrive } from "@/lib/cf/hyperdrive";
import { listQueues } from "@/lib/cf/queues";
import { listAiGateways } from "@/lib/cf/aiGateway";
import { listR2Buckets } from "@/lib/cf/r2";
import { listVectorizeIndexes } from "@/lib/cf/vectorize";
import { listAll, type CfRunner } from "@/lib/cf/runner";
import { D1DatabaseListOutput, KvNamespaceListOutput } from "@/lib/cf/schemas";
import { listWorkers } from "@/lib/cf/workers";
import { listWorkflows } from "@/lib/cf/workflows";
import { listCertificatePacks, packsToDelete, type CertificatePack } from "@/lib/domains/certificates";
import { dnsRecordsAt } from "@/lib/domains/records";
import { listZones, type Zone } from "@/lib/domains/zones";
import { errorMessage } from "@/lib/errors";
import { readInstall } from "@/lib/gateway/install";
import { listAppRows } from "@/lib/gateway/registry";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import type { EventSink } from "@/lib/output/events";
import { listed, plural } from "@/lib/output/text";
import { TeardownCode } from "./guards";
import {
  dnsRecordCount,
  emailChanges,
  EVERY_APP_PREFIX,
  isCustomDomainRecord,
  isEmailRoutingRecord,
  isEveryAppName,
  KINDS,
  planCounts,
  planTotal,
  type Kind,
  type PlannedEmailZone,
  type TeardownPlan,
} from "./plan";

const STEP = "teardown.inventory";

/** The Gateway's own Worker goes last: it binds the apps' Workers. */
function workerOrder(a: string, b: string): number {
  if (a === GATEWAY_WORKER_NAME) return 1;
  if (b === GATEWAY_WORKER_NAME) return -1;
  // An app before its helpers (`<app>--<helper>`), which it binds.
  return a.localeCompare(b);
}

const inZone = (host: string, zone: Zone): boolean =>
  host === zone.name || host.endsWith(`.${zone.name}`);

export async function inventoryAccount({
  cf,
  accountId,
  out,
}: {
  /** cf pinned to the account. */
  cf: CfRunner;
  accountId: string;
  out: EventSink;
}): Promise<TeardownPlan> {
  out.emit({
    type: "step",
    step: STEP,
    status: "start",
    message: `Looking for what Every App created in ${accountId}...`,
    data: { accountId },
  });
  const found = (kind: Kind, count: number, items: unknown) =>
    out.emit({
      type: "step",
      step: "teardown.found",
      status: "ok",
      message: `${count} ${KINDS.find(([name]) => name === kind)![count === 1 ? 1 : 2]}`,
      data: { kind, count, items },
    });
  /** What is never touched, as said to the person. */
  const kept: string[] = [];
  /**
   * One kind's listing: what it found, or `fallback` with a warning when
   * Cloudflare refused (a permission the token lacks, say), so the other
   * kinds are still deleted and the kind is said kept. A service the
   * account hasn't enabled (R2 code 10042, Access
   * `access.api.error.not_enabled`: 403 on a fresh account) has nothing of
   * ours in it: `fallback` with a skip step, no warning and nothing kept.
   */
  const read = async <T>(what: string, fallback: T, listing: () => Promise<T>): Promise<T> => {
    try {
      return await listing();
    } catch (error) {
      const reason = errorMessage(error).split("\n")[0] ?? "";
      if (isServiceNotEnabled(error)) {
        const service = isCfError(error, "r2_not_enabled") ? "R2" : "Cloudflare Access";
        out.emit({
          type: "step",
          step: "teardown.found",
          status: "skip",
          message: `${service} isn't enabled in this account: nothing of its to delete`,
          data: { what, service, reason },
        });
        return fallback;
      }
      kept.push(`${what} (couldn't be listed: ${reason})`);
      out.emit({
        type: "warning",
        code: TeardownCode.ReadFailed,
        step: STEP,
        message: `Couldn't list ${what}; whatever is there is kept\n${reason}`,
        data: { what, reason, fix: "check the token's permissions (runbook step 5), then run again" },
      });
      return fallback;
    }
  };

  // 1. The Gateway's D1: what the registry and the resource ledger name.
  const databaseId = await read("the Gateway's database", null, () => findGatewayDatabase(cf));
  const db = databaseId ? cfD1Database(cf, databaseId) : null;
  const install = db ? await read("the Gateway's install row", null, () => readInstall(db)) : null;
  const appRows = db ? await read("the Gateway's apps", [], () => listAppRows(db)) : [];
  const recorded = db ? await read("the apps' recorded resources", [], () => readAllRecordedResources(db)) : [];
  const recordedNames = (kind: string) =>
    new Set(recorded.filter((resource) => resource.kind === kind).map((resource) => resource.name));
  const ours = (kind: string, name: string) => isEveryAppName(name) || recordedNames(kind).has(name);
  const appWorkerNames = new Set(appRows.flatMap((row) => (row.workerName ? [row.workerName] : [])));

  // 2. Workers, with the Custom Domains that reference each.
  const listedWorkers = await read("the Workers", [], () => listWorkers(cf));
  const workers = listedWorkers
    .filter((worker) => ours("worker", worker.name) || appWorkerNames.has(worker.name))
    .sort((a, b) => workerOrder(a.name, b.name))
    .map((worker) => ({
      name: worker.name,
      domains: (worker.references?.domains ?? []).map((domain) => domain.hostname.toLowerCase()).sort(),
    }));
  found("workers", workers.length, workers.map((worker) => worker.name));

  // 3. Workflows run by our Workers (or named like them).
  const workflows = (await read("the Workflows", [], () => listWorkflows(cf, EVERY_APP_PREFIX)))
    .filter((workflow) => isEveryAppName(workflow.script_name ?? "") || isEveryAppName(workflow.name))
    .map((workflow) => workflow.name)
    .sort();
  found("workflows", workflows.length, workflows);

  // 4. D1 databases: the apps' first, the Gateway's last.
  const d1 = (
    await read("the D1 databases", [], () =>
      listAll(cf, ["d1", "list"], D1DatabaseListOutput, { perPage: 100, maxPages: 10 }),
    )
  )
    .filter((database) => ours("d1", database.name))
    .map((database) => ({ name: database.name, id: database.uuid }))
    .sort((a, b) => (a.id === databaseId ? 1 : b.id === databaseId ? -1 : a.name.localeCompare(b.name)));
  found("d1", d1.length, d1.map((database) => database.name));

  // 5. KV namespaces.
  const kv = (
    await read("the KV namespaces", [], () =>
      listAll(cf, ["kv", "namespaces", "list"], KvNamespaceListOutput, { perPage: 100, maxPages: 50 }),
    )
  )
    .filter((namespace) => ours("kv", namespace.title))
    .map((namespace) => ({ title: namespace.title, id: namespace.id }))
    .sort((a, b) => a.title.localeCompare(b.title));
  found("kv", kv.length, kv.map((namespace) => namespace.title));

  // 6. R2 buckets (never recorded: by name alone; those of the default
  // jurisdiction, the only one cf lists without being told another).
  const r2 = (await read("the R2 buckets", [], () => listR2Buckets(cf, EVERY_APP_PREFIX)))
    .filter(isEveryAppName)
    .sort();
  found("r2", r2.length, r2);

  // 7. Hyperdrive configs.
  const hyperdrive = (await read("the Hyperdrive configs", [], () => listHyperdrive(cf)))
    .filter((config) => ours("hyperdrive", config.name))
    .map((config) => ({ name: config.name, id: config.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  found("hyperdrive", hyperdrive.length, hyperdrive.map((config) => config.name));

  // 7b. Queues (by `queue_name`), and the consumers on any queue that are
  // our Workers: Cloudflare won't delete a Worker while it consumes.
  const listedQueues = await read("the queues", [], () => listQueues(cf));
  const queues = listedQueues
    .filter((queue) => ours("queue", queue.queue_name))
    .map((queue) => ({ name: queue.queue_name, id: queue.queue_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const plannedWorkers = new Set(workers.map((worker) => worker.name));
  const queueConsumers = listedQueues
    .flatMap((queue) =>
      (queue.consumers ?? []).flatMap((consumer) =>
        consumer.consumer_id && plannedWorkers.has(consumer.script ?? "")
          ? [{ queueId: queue.queue_id, queueName: queue.queue_name, consumerId: consumer.consumer_id, script: consumer.script! }]
          : [],
      ),
    )
    .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.script.localeCompare(b.script));
  found(
    "queueConsumers",
    queueConsumers.length,
    queueConsumers.map((consumer) => `${consumer.script} on ${consumer.queueName}`),
  );
  found("queues", queues.length, queues.map((queue) => queue.name));

  // 7c. Vectorize indexes, by name (an app's are `<worker>--<binding>`).
  const vectorize = (await read("the Vectorize indexes", [], () => listVectorizeIndexes(cf)))
    .map((index) => index.name)
    .filter((name) => ours("vectorize", name))
    .sort();
  found("vectorize", vectorize.length, vectorize);
  // 7d. AI Gateways, by id (`<worker>-<binding>`: one hyphen, still every-*).
  const aiGateway = (await read("the AI Gateways", [], () => listAiGateways(cf, EVERY_APP_PREFIX)))
    .map((gateway) => gateway.id)
    .filter((id) => ours("ai-gateway", id))
    .sort();
  found("aiGateway", aiGateway.length, aiGateway);

  // 8. Access: the applications by what they cover (with an install row to
  // say what that is) and by name, and the policy by name. The team and
  // its identity providers are kept: Cloudflare has no API to delete a team.
  const access: TeardownPlan["access"] = { applications: [], policy: null };
  const organization = await read("the Zero Trust team", null, () => getAccessOrganization(cf));
  if (organization) {
    const scope: AccessScope | null = install
      ? { gatewayHost: install.gatewayHost.toLowerCase(), appBaseDomain: install.appBaseDomain.toLowerCase() }
      : null;
    const applications = await read("the Access applications", [], () => listAccessApplications(cf));
    const covering = scope ? findAccessApplications(applications, scope) : { gateway: null, apps: null };
    const named = applications.filter(
      (application) => application.name === GATEWAY_APPLICATION_NAME || application.name === APPS_APPLICATION_NAME,
    );
    const chosen = new Map<string, AccessApplication>();
    for (const application of [covering.gateway, covering.apps, ...named]) {
      if (application) chosen.set(application.id, application);
    }
    access.applications = [...chosen.values()].map((application) => ({
      id: application.id,
      name: application.name ?? application.id,
    }));
    const policy = (await read("the Access policies", [], () => listAccessPolicies(cf))).find(
      (candidate) => candidate.name === POLICY_NAME,
    );
    access.policy = policy ? { id: policy.id, name: policy.name } : null;
    kept.push(`the Zero Trust team ${organization.auth_domain} and its identity providers`);
  }
  found("access", access.applications.length + (access.policy ? 1 : 0), {
    applications: access.applications.map((application) => application.name),
    policy: access.policy?.name ?? null,
  });

  // 9. The hostnames Every App published, and the zones they are in. Only
  // the account's own zones (listed once): a zone id the install row or a
  // Custom Domain names is data, and the zone-plane steps below act by zone
  // id, so one outside the account is never planned, whatever the token
  // could reach.
  const hostnames = new Set<string>();
  if (install) {
    hostnames.add(install.gatewayHost.toLowerCase());
    for (const host of install.liveDomains) hostnames.add(host.toLowerCase());
  }
  for (const row of appRows) if (row.hostname) hostnames.add(row.hostname.toLowerCase());
  for (const worker of workers) for (const host of worker.domains) hostnames.add(host);
  const accountZones = new Map<string, Zone>(
    (await read("the account's zones", [], () => listZones(cf, accountId))).map((zone) => [
      zone.id,
      { id: zone.id, name: zone.name },
    ]),
  );
  const zones = new Map<string, Zone>();
  const addZone = (id: string, name: string) => {
    const own = accountZones.get(id);
    if (own) zones.set(own.id, own);
    else kept.push(`the zone ${name.toLowerCase()} (${id}), which isn't in account ${accountId}`);
  };
  if (install) addZone(install.zoneId, install.zoneName);
  for (const worker of listedWorkers) {
    if (!workers.some((planned) => planned.name === worker.name)) continue;
    for (const domain of worker.references?.domains ?? []) {
      if (domain.zone_id && domain.zone_name) addZone(domain.zone_id, domain.zone_name);
    }
  }
  const zoneOf = (host: string): Zone | null => {
    const zone = [...accountZones.values()]
      .filter((candidate) => inZone(host, candidate))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (zone) zones.set(zone.id, zone);
    return zone ?? null;
  };
  const hostZones = new Map<string, Zone>();
  for (const host of [...hostnames].sort()) {
    const zone = zoneOf(host);
    if (zone) hostZones.set(host, zone);
  }
  for (const zone of zones.values()) kept.push(`the zone ${zone.name}`);
  kept.push("the Workers Paid subscription", "the workers.dev subdomain");

  // 10. Email Routing, zone by zone: rules to our Workers, a catch-all to
  // one, and routing itself once no rule and no catch-all of anyone else's
  // needs it (a catch-all of theirs that forwards mail keeps it on).
  const email: PlannedEmailZone[] = [];
  for (const zone of [...zones.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const routing = await read(`Email Routing on ${zone.name}`, null, async () => ({
      settings: await getEmailRoutingSettings(cf, zone.id),
      rules: await listEmailRoutingRules(cf, zone.id),
      catchAll: await getEmailRoutingCatchAll(cf, zone.id),
    }));
    if (!routing) continue;
    const { settings, rules, catchAll } = routing;
    const oursRules = rules.filter((rule) => rule.id !== null && isEveryAppName(ruleWorker(rule) ?? ""));
    const catchAllWorker = ruleWorker(catchAll);
    const catchAllOurs = catchAllWorker !== null && isEveryAppName(catchAllWorker);
    if (oursRules.length === 0 && !catchAllOurs) continue;
    const catchAllInert = !catchAll.enabled || catchAll.actions.every((action) => action.type === "drop");
    email.push({
      zoneId: zone.id,
      zoneName: zone.name,
      rules: oursRules.map((rule) => ({ id: rule.id!, address: ruleAddress(rule), worker: ruleWorker(rule)! })),
      catchAllWorker: catchAllOurs ? catchAllWorker : null,
      disable: settings.enabled && oursRules.length === rules.length && (catchAllOurs || catchAllInert),
    });
  }
  found("email", emailChanges(email), email);

  // 11. Certificate packs of those hostnames: never the zone's Universal
  // pack, never one that would leave another name without a certificate
  // (a pack chosen for one hostname no longer vouches for the next).
  const certificates: TeardownPlan["certificates"] = [];
  const packsByZone = new Map<string, CertificatePack[]>();
  for (const [host, zone] of hostZones) {
    let packs = packsByZone.get(zone.id);
    if (!packs) {
      packs = await read(`the certificate packs of ${zone.name}`, [], () => listCertificatePacks(cf, zone.id));
      packsByZone.set(zone.id, packs);
    }
    for (const pack of packsToDelete(packs, host)) {
      packs.splice(packs.indexOf(pack), 1);
      certificates.push({ zoneId: zone.id, zoneName: zone.name, hostname: host, packId: pack.id });
    }
  }
  found("certificates", certificates.length, certificates.map((pack) => `${pack.packId} (${pack.hostname})`));

  // 12. DNS at exactly those names: only what a Workers Custom Domain
  // creates (A, AAAA, CNAME), read again after the Workers go, since a
  // Custom Domain's record goes with it. everyapp writes no other record,
  // so a zone's MX, TXT, CAA and the rest at the same names (mail, a
  // verification, next to the Custom Domain) are someone else's and kept;
  // Email Routing's own go when it is turned off.
  const dns: TeardownPlan["dns"] = [];
  for (const [name, zone] of [...hostZones].sort(([a], [b]) => a.localeCompare(b))) {
    const records = await read(`the DNS records at ${name}`, [], () => dnsRecordsAt(cf, zone.id, name));
    const others = [
      ...new Set(
        records
          .filter(
            (record) =>
              !isCustomDomainRecord(record) &&
              !isEmailRoutingRecord({ type: record.type, content: record.content ?? null }),
          )
          .map((record) => record.type.toUpperCase()),
      ),
    ].sort();
    if (others.length > 0) {
      kept.push(`the ${listed(others)} ${others.length === 1 ? "record" : "records"} at ${name}, which Every App never created`);
    }
    dns.push({
      zoneId: zone.id,
      zoneName: zone.name,
      name,
      records: records
        .filter(isCustomDomainRecord)
        .map((record) => ({ id: record.id, type: record.type, content: record.content ?? null })),
    });
  }
  found("dns", dnsRecordCount(dns), dns.filter((name) => name.records.length > 0));

  const plan: TeardownPlan = {
    accountId,
    gateway: databaseId ? { databaseId, gatewayHost: install?.gatewayHost ?? null } : null,
    workers,
    workflows,
    d1,
    kv,
    r2,
    hyperdrive,
    queues,
    queueConsumers,
    vectorize,
    aiGateway,
    access,
    email,
    certificates,
    dns,
    kept,
  };
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `Found ${plural(planTotal(plan), "resource")} of Every App's in ${accountId}.`,
    data: { accountId, counts: planCounts(plan), total: planTotal(plan) },
  });
  return plan;
}
