/**
 * What `everyapp teardown` found in an account and would delete, in the
 * order it deletes it (./inventory.ts fills it in, ./delete.ts carries it
 * out), and how it is said: to a person as a block of facts, to a script
 * as `data.plan`.
 */
import chalk from "chalk";
import { RESOURCE_LABELS } from "@/lib/app/ownership";
import { formatFacts } from "@/lib/output/table";
import { plural } from "@/lib/output/text";

/** Every Worker, database, namespace, bucket and config Every App makes is named so. */
export const EVERY_APP_PREFIX = "every-";

export const isEveryAppName = (name: string): boolean => name.startsWith(EVERY_APP_PREFIX);

/**
 * A record Email Routing keeps on a domain it routes (its MX records and
 * SPF). Never one of the DNS leftovers: turning routing off removes them,
 * and while routing stays on (someone else's rule) they are its.
 */
export const isEmailRoutingRecord = (record: { type: string; content: string | null }): boolean =>
  (record.type === "MX" && /\.mx\.cloudflare\.net\.?$/i.test(record.content ?? "")) ||
  (record.type === "TXT" && /_spf\.mx\.cloudflare\.net/i.test(record.content ?? ""));

/**
 * The record types a Workers Custom Domain creates (or that would stand in
 * its way: lib/domains/preflight.ts): the only DNS the teardown deletes,
 * since everyapp writes no record of its own. A zone's MX, TXT, CAA and
 * the rest at the same name are someone else's.
 */
const CUSTOM_DOMAIN_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

export const isCustomDomainRecord = (record: { type: string }): boolean =>
  CUSTOM_DOMAIN_RECORD_TYPES.has(record.type.toUpperCase());

interface PlannedWorker {
  name: string;
  /** Its Custom Domains, which go with it. */
  domains: string[];
}

export interface PlannedEmailZone {
  zoneId: string;
  zoneName: string;
  /** Rules that send mail to an `every-*` Worker. */
  rules: Array<{ id: string; address: string | null; worker: string }>;
  /** The Worker the catch-all sends mail to, when it is one of ours; it goes back to dropping mail. */
  catchAllWorker: string | null;
  /**
   * Routing is on and nothing else's needs it (no rule of theirs, no
   * catch-all of theirs that does anything): turn it off, so the MX
   * records Cloudflare added go.
   */
  disable: boolean;
}

interface PlannedCertificatePack {
  zoneId: string;
  zoneName: string;
  hostname: string;
  packId: string;
}

interface PlannedDnsName {
  zoneId: string;
  zoneName: string;
  name: string;
  /** The Custom Domain records (A, AAAA, CNAME) there when the inventory ran; read again after the Workers go. */
  records: Array<{ id: string; type: string; content: string | null }>;
}

export interface TeardownPlan {
  accountId: string;
  /** The Gateway's D1, and its install row's host, when the account has one. */
  gateway: { databaseId: string; gatewayHost: string | null } | null;
  /** Apps and helpers first, the Gateway's Worker last. */
  workers: PlannedWorker[];
  workflows: string[];
  /** Apps' first, the Gateway's last (deleted last of all: it is the inventory's source). */
  d1: Array<{ name: string; id: string }>;
  kv: Array<{ title: string; id: string }>;
  r2: string[];
  hyperdrive: Array<{ name: string; id: string }>;
  access: {
    applications: Array<{ id: string; name: string }>;
    policy: { id: string; name: string } | null;
  };
  email: PlannedEmailZone[];
  certificates: PlannedCertificatePack[];
  dns: PlannedDnsName[];
  /** What is never touched, as said to the person. */
  kept: string[];
}

/** The kinds, in deletion order, each with its label for one and for many. */
export const KINDS = [
  ["access", "Access application or policy", "Access applications and policy"],
  ["email", "Email Routing change", "Email Routing changes"],
  ["workflows", "Workflow", "Workflows"],
  ["workers", "Worker", "Workers"],
  ["certificates", "certificate pack", "certificate packs"],
  ["d1", "D1 database", "D1 databases"],
  ["kv", "KV namespace", "KV namespaces"],
  ["r2", "R2 bucket", "R2 buckets"],
  ["hyperdrive", "Hyperdrive config", "Hyperdrive configs"],
  ["dns", "DNS record", "DNS records"],
] as const;
export type Kind = (typeof KINDS)[number][0];

/** Where in the Cloudflare dashboard something kept is deleted by hand. */
export const PLACES: Readonly<Record<Kind, string>> = {
  access: "Zero Trust → Access → Applications and Policies",
  email: "the zone → Email → Email Routing",
  workflows: "Compute (Workers) → Workflows",
  workers: "Compute (Workers) → Workers & Pages",
  certificates: "the zone → SSL/TLS → Edge Certificates",
  d1: "Storage & Databases → D1",
  kv: "Storage & Databases → KV",
  r2: "Storage & Databases → R2 Object Storage",
  hyperdrive: "Storage & Databases → Hyperdrive",
  dns: "the zone → DNS → Records",
};

/** The Email Routing changes a plan makes: each rule, each catch-all reset, each zone turned off. */
export const emailChanges = (zones: readonly PlannedEmailZone[]): number =>
  zones.reduce(
    (sum, zone) => sum + zone.rules.length + (zone.catchAllWorker ? 1 : 0) + (zone.disable ? 1 : 0),
    0,
  );

/** The DNS records seen at the plan's names. */
export const dnsRecordCount = (names: readonly PlannedDnsName[]): number =>
  names.reduce((sum, name) => sum + name.records.length, 0);

/** How many items of each kind the plan deletes (email counts its changes, dns the records seen). */
export function planCounts(plan: TeardownPlan): Record<Kind, number> {
  return {
    access: plan.access.applications.length + (plan.access.policy ? 1 : 0),
    email: emailChanges(plan.email),
    workflows: plan.workflows.length,
    workers: plan.workers.length,
    certificates: plan.certificates.length,
    d1: plan.d1.length,
    kv: plan.kv.length,
    r2: plan.r2.length,
    hyperdrive: plan.hyperdrive.length,
    dns: dnsRecordCount(plan.dns),
  };
}

export function planTotal(plan: TeardownPlan): number {
  return Object.values(planCounts(plan)).reduce((sum, count) => sum + count, 0);
}

/** `Worker "every-acme-todo"`, as `removed` and `kept` list things. */
export const describe = {
  worker: (name: string) => `${RESOURCE_LABELS.worker} "${name}"`,
  workflow: (name: string) => `Workflow "${name}"`,
  d1: (name: string) => `${RESOURCE_LABELS.d1} "${name}"`,
  kv: (title: string) => `${RESOURCE_LABELS.kv} "${title}"`,
  r2: (name: string) => `${RESOURCE_LABELS.r2} "${name}"`,
  hyperdrive: (name: string) => `${RESOURCE_LABELS.hyperdrive} "${name}"`,
  application: (name: string) => `Access application "${name}"`,
  policy: (name: string) => `Access policy "${name}"`,
  rule: (address: string | null, zoneName: string) =>
    `Email Routing rule for ${address ?? "(no address)"} on ${zoneName}`,
  catchAll: (zoneName: string) => `catch-all of ${zoneName}`,
  routing: (zoneName: string) => `Email Routing on ${zoneName}`,
  pack: (packId: string, hostname: string) => `certificate pack ${packId} for ${hostname}`,
  record: (type: string, name: string) => `DNS ${type} record at ${name}`,
};

/** What each kind of the plan names, one line per kind that has something. */
function planItems(plan: TeardownPlan): Array<{ label: string; items: string[] }> {
  const counts = planCounts(plan);
  const items: Record<Kind, string[]> = {
    access: [
      ...plan.access.applications.map((application) => `application "${application.name}"`),
      ...(plan.access.policy ? [`policy "${plan.access.policy.name}"`] : []),
    ],
    email: plan.email.flatMap((zone) => [
      ...zone.rules.map((rule) => `rule for ${rule.address ?? "(no address)"} on ${zone.zoneName}`),
      ...(zone.catchAllWorker ? [`${zone.zoneName}'s catch-all back to dropping mail`] : []),
      ...(zone.disable ? [`Email Routing off for ${zone.zoneName}`] : []),
    ]),
    workflows: plan.workflows,
    workers: plan.workers.map((worker) =>
      worker.domains.length > 0 ? `${worker.name} (${worker.domains.join(", ")})` : worker.name,
    ),
    certificates: plan.certificates.map((pack) => `${pack.packId} (${pack.hostname})`),
    d1: plan.d1.map((database) => database.name),
    kv: plan.kv.map((namespace) => namespace.title),
    r2: plan.r2,
    hyperdrive: plan.hyperdrive.map((config) => config.name),
    dns: plan.dns.flatMap((name) => name.records.map((record) => `${record.type} at ${name.name}`)),
  };
  return KINDS.flatMap(([kind, , many]) =>
    counts[kind] === 0 ? [] : [{ label: `${many} (${counts[kind]})`, items: items[kind] }],
  );
}

/** The plan for a person: a block of facts, then what stays. */
export function planLines(plan: TeardownPlan): string[] {
  const facts = planItems(plan).map(({ label, items }) => ({ label, value: items.join(", ") }));
  return [
    ...(facts.length > 0 ? formatFacts(facts) : [chalk.dim("Nothing of Every App's to delete.")]),
    ...(plan.kept.length > 0 ? ["", chalk.dim(`Kept: ${plan.kept.join("; ")}.`)] : []),
  ];
}

/** The plan in a sentence: "14 resources: 3 Workers, 2 D1 databases, ...". */
export function planSummary(plan: TeardownPlan): string {
  const counts = planCounts(plan);
  const parts = KINDS.flatMap(([kind, one, many]) =>
    counts[kind] === 0 ? [] : [counts[kind] === 1 ? `1 ${one}` : `${counts[kind]} ${many}`],
  );
  return `${plural(planTotal(plan), "resource")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/** The plan as `data.plan`, for a script. */
export function planData(plan: TeardownPlan): Record<string, unknown> {
  return {
    accountId: plan.accountId,
    gateway: plan.gateway,
    counts: planCounts(plan),
    total: planTotal(plan),
    workers: plan.workers,
    workflows: plan.workflows,
    d1: plan.d1,
    kv: plan.kv,
    r2: plan.r2,
    hyperdrive: plan.hyperdrive,
    access: plan.access,
    email: plan.email,
    certificates: plan.certificates,
    dns: plan.dns,
    kept: plan.kept,
  };
}
