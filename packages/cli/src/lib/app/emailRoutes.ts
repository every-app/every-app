/**
 * The Email Routing routes `everyapp deploy` and `everyapp email set` keep
 * for an app's inbound addresses (its registry row's `email_inbound`, set
 * with `everyapp email set --inbound`): one rule per literal address
 * (`support@mail.example.com`) and a zone's catch-all for `*@<apex>`, each
 * sending mail to the app's
 * Worker by name (`actions: [{ type: "worker", value: [<worker>] }]`), so
 * its `email()` handler gets it. The deploy policy keeps refusing the
 * `email` trigger: cf's own reconciliation of a Worker's addresses would
 * fight these rules, and would need no ledger to take an address.
 *
 * Like the app's other resources, a route is the app's when the gateway's
 * D1 records it (./ownership.ts, kind `email-route`, one row per address:
 * `<zone id>/<rule id>`, or `catch_all:<zone id>`). An address another app
 * recorded, a rule another owner made, or a catch-all that already sends
 * mail elsewhere is refused, never taken over; a rule named after the
 * app's Worker (`everyapp:<worker>`), or one that already sends the
 * address to it (the manual step the docs gave before), is adopted.
 *
 * Two halves: `planEmailRoutes` reads and checks everything before the
 * upload (zones, whether each domain routes mail, the rules there), asking
 * at a terminal before Email Routing is turned on for a domain (it locks
 * the domain's MX and SPF records); `applyEmailRoutes` writes after the
 * upload, since a rule may only name a Worker that exists. Routes the list
 * dropped are deleted (a catch-all goes back to dropping mail), and so are
 * all of them with `delete --purge` (`removeEmailRoutes`).
 */
import type { D1Database } from "@/lib/cf/d1";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { confirmAtTerminal, confirmOrCancel, type Confirm } from "@/lib/output/prompt";
import {
  createEmailRoutingRule,
  deleteEmailRoutingRule,
  enableEmailRouting,
  getEmailRoutingCatchAll,
  getEmailRoutingRule,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  ruleAddress,
  ruleWorker,
  updateEmailRoutingCatchAll,
  updateEmailRoutingRule,
  type EmailRoutingRule,
  type EmailRoutingRuleBody,
  type EmailRoutingSettings,
} from "@/lib/cf/emailRouting";
import { isCfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { dnsRecordsAt } from "@/lib/domains/records";
import { resolveZone, type Zone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import { appIdOfWorker } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import {
  forgetOwnedResources,
  readOwnedResources,
  readResourcesOfKind,
  recordOwnedResource,
  type OwnedResource,
} from "./ownership";

/** The name of every rule (and catch-all) the deploy makes for a Worker. */
export function routeRuleName(workerName: string): string {
  return `everyapp:${workerName}`;
}

/** Where a recorded route is: a rule in a zone, or a zone's catch-all. */
type RouteLocation =
  | { kind: "rule"; zoneId: string; ruleId: string }
  | { kind: "catch_all"; zoneId: string };

function parseRouteId(resourceId: string | null): RouteLocation | null {
  if (!resourceId) return null;
  if (resourceId.startsWith("catch_all:")) {
    return { kind: "catch_all", zoneId: resourceId.slice("catch_all:".length) };
  }
  const [zoneId, ruleId] = resourceId.split("/");
  return zoneId && ruleId ? { kind: "rule", zoneId, ruleId } : null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

function isCatchAll(address: string): boolean {
  return address.startsWith("*@");
}

/** A route the manifest asks for, checked: where it goes and what is there already. */
interface PlannedRoute {
  address: string;
  zone: Zone;
  /** The rule (or catch-all) of the app's there already, adopted as it is. */
  existing: EmailRoutingRule | null;
}

interface EmailRoutesPlan {
  workerName: string;
  accountId: string;
  routes: PlannedRoute[];
  /** Domains to turn Email Routing on for, a zone's apex before its subdomains. */
  enable: Array<{ zone: Zone; domain: string }>;
  /** The app's recorded routes the manifest no longer lists. */
  dropped: OwnedResource[];
}

/**
 * Check the app's inbound addresses against the account before anything is
 * written; null when the app has no routes and asks for none. Asks (at a
 * terminal) before Email Routing is turned on for a domain that doesn't
 * route mail yet, unless `enableRouting` (`--enable-email-routing`).
 */
export async function planEmailRoutes({
  cf,
  gatewayDb,
  accountId,
  workerName,
  addresses,
  interactive,
  enableRouting = false,
  confirm = confirmAtTerminal,
}: {
  cf: CfRunner;
  gatewayDb: D1Database;
  accountId: string;
  workerName: string;
  /** The installation's inbound addresses (`apps.email_inbound`); the caller checks the declaration. */
  addresses: readonly string[];
  interactive: boolean;
  enableRouting?: boolean;
  confirm?: Confirm;
}): Promise<EmailRoutesPlan | null> {
  const owned = (await readOwnedResources(gatewayDb, workerName)).filter(
    (resource) => resource.kind === "email-route",
  );
  const dropped = owned.filter((route) => !addresses.includes(route.binding));
  if (addresses.length === 0) {
    return owned.length > 0
      ? { workerName, accountId, routes: [], enable: [], dropped }
      : null;
  }

  // One address, one app.
  const holders = await readResourcesOfKind(gatewayDb, "email-route");
  for (const address of addresses) {
    const holder = holders.find(
      (route) => route.name === address && route.workerName !== workerName,
    );
    if (holder) {
      const appId = await appIdOfWorker(gatewayDb, holder.workerName);
      throw new EveryAppError(
        "EMAIL_ADDRESS_TAKEN",
        `${address} already goes to another app${appId ? ` (${appId})` : ""}`,
        {
          fix: `pick another address, or run ${CLI} email unset inbound in ${appId ? `${appId}'s` : "that app's"} directory first`,
          data: { address, workerName: holder.workerName, appId },
        },
      );
    }
  }

  // The zones, and whether each domain routes mail.
  const zones = new Map<string, Zone>();
  for (const domain of new Set(addresses.map(domainOf))) {
    zones.set(domain, await emailZone(cf, domain, accountId));
  }
  for (const address of addresses.filter(isCatchAll)) {
    const zone = zones.get(domainOf(address))!;
    if (zone.name !== domainOf(address)) {
      throw new EveryAppError(
        "EMAIL_CATCH_ALL_NOT_APEX",
        `${address}: catch-alls only work on a zone's apex\n${domainOf(address)} is a subdomain of ${zone.name}.`,
        {
          fix: `list each address instead, e.g. --inbound support@${domainOf(address)}`,
          data: { address, zone: zone.name },
        },
      );
    }
  }
  const read = zoneReader(cf);
  const enable: EmailRoutesPlan["enable"] = [];
  for (const [domain, zone] of zones) {
    if (!(await routesMail(cf, zone, domain, await read.settings(zone.id)))) {
      enable.push({ zone, domain });
    }
  }
  // The apex first: a subdomain is added to a zone's Email Routing.
  enable.sort((a, b) => Number(a.domain !== a.zone.name) - Number(b.domain !== b.zone.name));

  // What is on each address now.
  const recordedRules = new Set(
    owned.flatMap((route) => {
      const location = parseRouteId(route.resourceId);
      return location?.kind === "rule" ? [location.ruleId] : [];
    }),
  );
  const ours = (rule: EmailRoutingRule) =>
    isWorkersRule(rule, workerName) || (rule.id !== null && recordedRules.has(rule.id));
  const routes: PlannedRoute[] = [];
  for (const address of addresses) {
    const zone = zones.get(domainOf(address))!;
    if (isCatchAll(address)) {
      const catchAll = await read.catchAll(zone.id);
      const sendsMail =
        catchAll.enabled && catchAll.actions.some((action) => action.type !== "drop");
      if (!ours(catchAll) && sendsMail) {
        throw new EveryAppError(
          "EMAIL_CATCH_ALL_TAKEN",
          `${zone.name}'s catch-all already ${delivery(catchAll)}\n${address} would take it over.`,
          {
            fix: "set the catch-all back to Drop (Email Routing → Routing rules), or list addresses one by one",
            data: { address, zone: zone.name, actions: catchAll.actions },
          },
        );
      }
      routes.push({ address, zone, existing: ours(catchAll) ? catchAll : null });
      continue;
    }
    const onAddress = (await read.rules(zone.id)).filter(
      (rule) => ruleAddress(rule) === address,
    );
    const foreign = onAddress.find((rule) => !ours(rule));
    if (foreign) {
      throw new EveryAppError(
        "EMAIL_ADDRESS_TAKEN",
        `${address} already ${delivery(foreign)}\nThe Email Routing rule ${foreign.name ? `"${foreign.name}"` : foreign.id} on ${zone.name} delivers it.`,
        {
          fix: "remove that rule, or pick another address",
          data: { address, zone: zone.name, ruleId: foreign.id, actions: foreign.actions },
        },
      );
    }
    const existing =
      onAddress.find((rule) => rule.id !== null && recordedRules.has(rule.id)) ??
      onAddress[0] ??
      null;
    routes.push({ address, zone, existing });
  }

  if (enable.length > 0 && !enableRouting) {
    const domains = enable.map(({ domain }) => domain);
    const list = domains.join(", ");
    const one = domains.length === 1;
    const locks = `Turning it on locks ${one ? "the domain's" : "their"} MX and SPF records to Cloudflare.`;
    const commands = enable.map(
      ({ zone, domain }) => `npx cf email-routing enable -z ${zone.name} --name ${domain}`,
    );
    if (!interactive) {
      throw new EveryAppError(
        "EMAIL_ROUTING_DISABLED",
        `Email Routing is off for ${list}\n${locks} Nothing was changed.`,
        { data: { domains, commands } },
      );
    }
    await confirmOrCancel(confirm, `Turn on Email Routing for ${list}?`, {
      context: [`Email Routing is off for ${list}. ${locks.replace("the domain's", "its")}`],
    });
  }
  return { workerName, accountId, routes, enable, dropped };
}

/**
 * Make the planned routes, after the app's Worker is uploaded: turn
 * Email Routing on where it was agreed, create or update each route
 * (recorded before it is created, so a retry finds it), then delete the
 * routes the manifest dropped. Returns the addresses routed, those whose
 * routes were removed, and whether anything was turned on, made, updated
 * or removed (false when every rule was already as wanted).
 */
export async function applyEmailRoutes({
  cf,
  gatewayDb,
  plan,
  onProgress,
}: {
  cf: CfRunner;
  gatewayDb: D1Database;
  plan: EmailRoutesPlan;
  onProgress?: (message: string) => void;
}): Promise<{ routed: string[]; removed: string[]; changed: boolean }> {
  const { workerName } = plan;
  let changed = false;
  const did = (message: string) => {
    changed = true;
    onProgress?.(message);
  };
  for (const { zone, domain } of plan.enable) {
    await enableEmailRouting(cf, zone.id, domain);
    did(`Turned on Email Routing for ${domain}.`);
  }
  for (const { address, zone, existing } of plan.routes) {
    const record = (resourceId: string | null) =>
      recordRoute(gatewayDb, workerName, address, resourceId);
    if (isCatchAll(address)) {
      const wanted = workerRule(workerName, { type: "all" });
      await record(`catch_all:${zone.id}`);
      if (!existing || !sameRule(existing, wanted)) {
        await updateEmailRoutingCatchAll(cf, zone.id, wanted);
        did(`${zone.name}'s catch-all sends mail to ${workerName}.`);
      }
      continue;
    }
    const wanted = workerRule(workerName, { type: "literal", field: "to", value: address });
    if (existing?.id) {
      await record(`${zone.id}/${existing.id}`);
      if (!sameRule(existing, wanted)) {
        await updateEmailRoutingRule(cf, zone.id, existing.id, wanted);
        did(`Updated the Email Routing rule for ${address}.`);
      }
      continue;
    }
    // Claimed first: a retry after a create whose id went unrecorded
    // finds the rule by its name and address, and adopts it.
    await record(null);
    const ruleId = await createEmailRoutingRule(cf, zone.id, wanted);
    await record(`${zone.id}/${ruleId}`);
    did(`Created the Email Routing rule for ${address}.`);
  }
  for (const route of plan.dropped) {
    await removeRoute(cf, gatewayDb, workerName, plan.accountId, route);
    did(`Removed the route for ${route.name}, which the app's inbound addresses no longer list.`);
  }
  return {
    routed: plan.routes.map((route) => route.address),
    removed: plan.dropped.map((route) => route.name),
    changed,
  };
}

/** Where the app's mail goes now, and what replying from those addresses still needs. */
export function describeMailRoutes({
  appId,
  workerName,
  senders,
  routed,
  removed,
  sendersSettable,
}: {
  appId: string;
  workerName: string;
  senders: readonly string[];
  routed: readonly string[];
  removed: readonly string[];
  /**
   * Whether `everyapp email set --sender` takes this app's senders: it
   * declares `capabilities.email`, and the Gateway isn't hosted (a hosted
   * one sends app mail from its own sender only). Otherwise the reply hint,
   * which names that command, is left out.
   */
  sendersSettable: boolean;
}): string {
  const gone = removed.length ? ` Removed the routes for ${removed.join(", ")}.` : "";
  if (routed.length === 0) return `${appId} receives no mail.${gone}`;
  const unsent = unsentDomains(routed, senders);
  const one = unsent.length === 1;
  const replies =
    unsent.length && sendersSettable
      ? ` To reply from ${unsent.join(", ")}, onboard ${one ? "it" : "them"} to Email Sending and list ${one ? "it" : "them"} with \`${CLI} email set --sender\` (docs/runbooks/email-sending-setup.md).`
      : "";
  return `Mail to ${routed.join(", ")} goes to ${workerName}.${gone}${replies}`;
}

/** The domains of `routed` addresses no sender covers: replying from them needs one. */
export function unsentDomains(routed: readonly string[], senders: readonly string[]): string[] {
  return [...new Set(routed.map(domainOf))].filter(
    (domain) => !senders.some((sender) => sender.endsWith(`@${domain}`)),
  );
}

/**
 * Delete every route the app recorded (`delete --purge`); returns what
 * was removed, as sentences' objects.
 */
export async function removeEmailRoutes({
  cf,
  gatewayDb,
  accountId,
  workerName,
  routes,
}: {
  cf: CfRunner;
  gatewayDb: D1Database;
  accountId: string;
  workerName: string;
  routes: readonly OwnedResource[];
}): Promise<string[]> {
  const removed: string[] = [];
  for (const route of routes) {
    if (await removeRoute(cf, gatewayDb, workerName, accountId, route)) {
      removed.push(
        isCatchAll(route.name)
          ? `the catch-all of ${domainOf(route.name)} (it drops mail again)`
          : `the Email Routing rule for ${route.name}`,
      );
    }
  }
  return removed;
}

/** What is wrong with one of an app's recorded routes. */
export interface EmailRouteProblem {
  workerName: string;
  address: string;
  problem: string;
}

/**
 * The recorded routes that don't deliver to their app's Worker (`status`):
 * the rule is gone, off or sends mail elsewhere, the catch-all changed, or
 * Email Routing is off for the domain.
 */
export async function emailRouteProblems(
  cf: CfRunner,
  routes: ReadonlyArray<OwnedResource & { workerName: string }>,
): Promise<EmailRouteProblem[]> {
  const read = zoneReader(cf);
  const problems: EmailRouteProblem[] = [];
  for (const route of routes) {
    const report = (problem: string) =>
      problems.push({ workerName: route.workerName, address: route.name, problem });
    const location = parseRouteId(route.resourceId);
    if (!location) {
      report("a deploy stopped before recording its rule");
      continue;
    }
    const rule =
      location.kind === "catch_all"
        ? await read.catchAll(location.zoneId)
        : await getEmailRoutingRule(cf, location.zoneId, location.ruleId);
    if (!rule) {
      report("its Email Routing rule is gone");
      continue;
    }
    if (!rule.enabled || ruleWorker(rule) !== route.workerName) {
      report(
        location.kind === "catch_all"
          ? `the catch-all ${rule.enabled ? `sends mail ${describeActions(rule)}` : "is off"}`
          : `its rule ${rule.enabled ? `sends mail ${describeActions(rule)}` : "is off"}`,
      );
      continue;
    }
    const settings = await read.settings(location.zoneId);
    const domain = domainOf(route.name);
    const zone = { id: location.zoneId, name: settings.name?.toLowerCase() ?? domain };
    if (!(await routesMail(cf, zone, domain, settings))) {
      report(`Email Routing is off for ${domain}`);
    }
  }
  return problems;
}

/** The zone that holds `domain`, refused in Email Routing's own words. */
async function emailZone(cf: CfRunner, domain: string, accountId: string): Promise<Zone> {
  try {
    return await resolveZone(cf, domain, accountId);
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "ZONE_NOT_FOUND") {
      throw new EveryAppError(
        "EMAIL_ZONE_NOT_FOUND",
        `${domain} isn't on Cloudflare DNS in this account\nEmail Routing needs the domain's zone in the Gateway's Cloudflare account.`,
        {
          fix: "add the domain (or its parent) to the account, or pick an address on another domain",
          data: { domain },
        },
      );
    }
    throw error;
  }
}

/**
 * Whether Email Routing takes `domain`'s mail: the zone's own setting for
 * its apex; for a subdomain, the MX records Email Routing adds there once
 * the subdomain is added to the zone's routing.
 */
async function routesMail(
  cf: CfRunner,
  zone: Zone,
  domain: string,
  settings: EmailRoutingSettings,
): Promise<boolean> {
  if (domain === zone.name) return settings.enabled;
  const records = await dnsRecordsAt(cf, zone.id, domain);
  return records.some(
    (record) =>
      record.type === "MX" && /\.mx\.cloudflare\.net\.?$/i.test(record.content ?? ""),
  );
}

/** Each zone's settings, rules and catch-all, read once. */
function zoneReader(cf: CfRunner) {
  const settings = new Map<string, Promise<EmailRoutingSettings>>();
  const rules = new Map<string, Promise<EmailRoutingRule[]>>();
  const catchAlls = new Map<string, Promise<EmailRoutingRule>>();
  const once = <T>(cache: Map<string, Promise<T>>, zoneId: string, read: () => Promise<T>) => {
    let value = cache.get(zoneId);
    if (!value) {
      value = read();
      cache.set(zoneId, value);
    }
    return value;
  };
  return {
    settings: (zoneId: string) => once(settings, zoneId, () => getEmailRoutingSettings(cf, zoneId)),
    rules: (zoneId: string) => once(rules, zoneId, () => listEmailRoutingRules(cf, zoneId)),
    catchAll: (zoneId: string) => once(catchAlls, zoneId, () => getEmailRoutingCatchAll(cf, zoneId)),
  };
}

/** A rule (or catch-all) that sends mail matching `matcher` to the Worker. */
function workerRule(
  workerName: string,
  matcher: EmailRoutingRuleBody["matchers"][number],
): EmailRoutingRuleBody {
  return {
    name: routeRuleName(workerName),
    enabled: true,
    matchers: [matcher],
    actions: [{ type: "worker", value: [workerName] }],
  };
}

/** What a catch-all goes back to once no app routes it. */
const DROP_CATCH_ALL: EmailRoutingRuleBody = {
  name: "",
  enabled: false,
  matchers: [{ type: "all" }],
  actions: [{ type: "drop" }],
};

/** A rule (or catch-all) the app's Worker made, or that sends mail to it. */
function isWorkersRule(rule: EmailRoutingRule, workerName: string): boolean {
  return rule.name === routeRuleName(workerName) || ruleWorker(rule) === workerName;
}

function sameRule(rule: EmailRoutingRule, wanted: EmailRoutingRuleBody): boolean {
  const wantedMatcher = wanted.matchers[0]!;
  return (
    rule.name === wanted.name &&
    rule.enabled === wanted.enabled &&
    rule.actions.length === 1 &&
    ruleWorker(rule) === wanted.actions[0]!.value![0] &&
    rule.matchers.length === 1 &&
    rule.matchers[0]!.type === wantedMatcher.type &&
    ("value" in wantedMatcher ? ruleAddress(rule) === wantedMatcher.value : true)
  );
}

/** What a rule someone else made does with mail, after "already": "forwards to ben@gmail.com". */
function delivery(rule: EmailRoutingRule): string {
  const action = rule.actions[0];
  if (!action || action.type === "drop") return "drops mail";
  if (action.type === "forward") return `forwards to ${action.value?.[0] ?? "an address"}`;
  if (action.type === "worker") return "goes to another Worker";
  return `sends mail to "${action.type}"`;
}

function describeActions(rule: EmailRoutingRule): string {
  const action = rule.actions[0];
  if (!action) return "nowhere";
  const target = action.value?.[0];
  if (action.type === "worker") return `to the Worker ${target ?? "(unnamed)"}`;
  if (action.type === "forward") return `to ${target ?? "an address"}`;
  return `to "${action.type}"`;
}

/** Record an address as the app's, refused when another app holds it. */
async function recordRoute(
  gatewayDb: D1Database,
  workerName: string,
  address: string,
  resourceId: string | null,
): Promise<void> {
  try {
    await recordOwnedResource(gatewayDb, workerName, {
      kind: "email-route",
      binding: address,
      name: address,
      resourceId,
    });
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "RESOURCE_OWNED") {
      throw new EveryAppError(
        "EMAIL_ADDRESS_TAKEN",
        `${address} was recorded for another app while this run was routing it`,
        { fix: "take another address, or remove it from that app first", data: { address } },
      );
    }
    throw error;
  }
}

/**
 * Delete one recorded route and forget it: its rule, or the zone's
 * catch-all set back to dropping mail when it is still the app's. A route
 * whose rule id was never recorded is looked for by its name and address.
 * Returns whether anything in Cloudflare changed.
 */
async function removeRoute(
  cf: CfRunner,
  gatewayDb: D1Database,
  workerName: string,
  accountId: string,
  route: OwnedResource,
): Promise<boolean> {
  const location = parseRouteId(route.resourceId);
  let changed = false;
  try {
    if (location?.kind === "rule") {
      changed = await deleteEmailRoutingRule(cf, location.zoneId, location.ruleId);
    } else if (location?.kind === "catch_all") {
      const catchAll = await getEmailRoutingCatchAll(cf, location.zoneId);
      if (isWorkersRule(catchAll, workerName)) {
        await updateEmailRoutingCatchAll(cf, location.zoneId, DROP_CATCH_ALL);
        changed = true;
      }
    } else {
      changed = await removeUnrecordedRule(cf, workerName, accountId, route.name);
    }
  } catch (error) {
    // The zone went with its rules: nothing of the route is left.
    if (!isCfError(error, "not_found")) throw error;
  }
  await forgetOwnedResources(gatewayDb, workerName, {
    kind: "email-route",
    binding: route.binding,
  });
  return changed;
}

/** A claimed route's rule, created before its id was recorded. */
async function removeUnrecordedRule(
  cf: CfRunner,
  workerName: string,
  accountId: string,
  address: string,
): Promise<boolean> {
  if (isCatchAll(address)) return false;
  // The zone isn't recorded: the one the deploy would find, if any.
  let zoneId: string;
  try {
    zoneId = (await resolveZone(cf, domainOf(address), accountId)).id;
  } catch (error) {
    if (error instanceof EveryAppError) return false;
    throw error;
  }
  let changed = false;
  for (const rule of await listEmailRoutingRules(cf, zoneId)) {
    if (rule.id && rule.name === routeRuleName(workerName) && ruleAddress(rule) === address) {
      changed = (await deleteEmailRoutingRule(cf, zoneId, rule.id)) || changed;
    }
  }
  return changed;
}

/** What the manifest declares about mail: it sends (the email capability), it receives (inbound). */
export function emailDeclarations(manifest: EveryAppCliManifest): { sends: boolean; receives: boolean } {
  return {
    sends: manifest.capabilities?.["email"]?.access === "write",
    receives: manifest.email?.inbound === true,
  };
}
