/**
 * What `everyapp status` suggests doing next, from the state it already
 * read (docs/design/2026-10-proactive-next-steps.md, section 5): the rules
 * are pure functions of facts, so a satisfied rule disappears on the next
 * run and nothing is stored to dismiss one. A step never repeats a fix
 * (`problems.ts`): what is off comes first, as a fix; what is merely not
 * done yet comes here. At most four, in the order below. `status` runs as
 * the operator (ADR-0003), so every rule shows there; people see them as a
 * `Next:` block after the fixes, scripts as `data.next`.
 */
import { DEV_AI_PROVIDERS, type ProviderAppId } from "@every-app/sdk/internal";
import type { AccessState } from "@/lib/access/settings";
import type { OrganizationCounts } from "@/lib/gateway/counts";
import type { InstallRecord } from "@/lib/gateway/install";
import type { GatewayOwner } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import { listed, plural } from "@/lib/output/text";
import { isServed, needsSetup, type AppState, type Problem } from "./problems";

export enum NextCode {
  AiKey = "AI_KEY",
  ProviderOffer = "PROVIDER_OFFER",
  ProviderKey = "PROVIDER_KEY",
  AccessOff = "ACCESS_OFF",
  Invite = "INVITE",
  ConnectAi = "CONNECT_AI",
  CreateApp = "CREATE_APP",
  EmailUnset = "EMAIL_UNSET",
}

/** One thing to do next: a command to run or a page to open, what it does, and the state that suggests it. */
export interface NextStep {
  code: NextCode;
  command?: string;
  url?: string;
  /** What the command or page does, a few words. */
  note: string;
  /** The state behind it, one sentence. */
  why: string;
}

/** An MCP app the Gateway offers (tier `provider`), as `data.providers` of `mcp list` has it. */
export interface ProviderFact {
  id: ProviderAppId;
  name: string;
  /** The capability whose key it uses (`dataforseo`), which a deployed app may list too. */
  capability: string;
  /** The Gateway setting holding its key (`DATAFORSEO_API_KEY`). */
  keySetting: string;
  /** The install organization has it on. */
  on: boolean;
}

export interface NextFacts {
  /** The install row's deployment mode; null before the first upload recorded one. */
  mode: InstallRecord["deploymentMode"];
  /** The install row names a live version: the Gateway Worker exists. */
  uploaded: boolean;
  gatewayUrl: string;
  owner: GatewayOwner | null;
  /** The apps status reports on (provider rows left out). */
  apps: AppState[];
  /** The Gateway Worker's secret names; null when they couldn't be read. */
  gatewayNames: readonly string[] | null;
  /** Whether Cloudflare Access is in front; null when it doesn't apply or wasn't read. */
  access: AccessState | null;
  providers: ProviderFact[];
  /** The install organization's counts; null when there is no owner yet or they couldn't be read. */
  counts: OrganizationCounts | null;
  /** What status found off: a step never repeats one of these. */
  problems: Problem[];
}

/** How many steps status suggests at most. */
export const NEXT_STEPS_MAX = 4;

/** The connector steps for Claude, Cursor and the rest. */
const CONNECT_AI_DOCS = "https://everyapp.com/docs/connect-ai";

/** The Gateway settings that turn AI on for apps, one per provider. */
const AI_KEYS: readonly string[] = Object.values(DEV_AI_PROVIDERS).map((spec) => spec.keyEnv);

/**
 * Whether a fix names the setting already: an app that needs setup lists
 * it unmet, and `APP_NEEDS_SETUP` says so with the one `configure <app>`
 * that asks for it (problems.ts `appNeedsSetup`).
 */
function fixNames(apps: AppState[], name: string): boolean {
  return apps.some(
    (app) => needsSetup(app) && app.setup!.unmet.some((setting) => setting.names.includes(name)),
  );
}

/** The apps whose manifests list `capability`, by id. */
function appsListing(apps: AppState[], capability: string): string[] {
  return apps
    .filter((app) =>
      app.setup?.settings.some((setting) => setting.kind === "capability" && setting.id === capability),
    )
    .map((app) => app.id);
}

/**
 * Apps that use AI, and no AI key on the Gateway: the key the apps name.
 * An app whose provider is required already has its fix (APP_NEEDS_SETUP
 * lists the key unmet), so this is for the ones that run without it, and
 * never names a key a fix names.
 */
function aiKey(facts: NextFacts): NextStep | null {
  const { apps, gatewayNames } = facts;
  if (!gatewayNames || AI_KEYS.some((key) => gatewayNames.includes(key))) return null;
  const names: string[] = [];
  const using: string[] = [];
  for (const app of apps) {
    const keys = (app.setup?.settings ?? [])
      .filter((setting) => setting.kind === "provider" && setting.set === false)
      .flatMap((setting) => setting.names.filter((name) => AI_KEYS.includes(name)))
      .filter((name) => !fixNames(apps, name));
    if (keys.length === 0) continue;
    using.push(app.id);
    for (const name of keys) if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  return {
    code: NextCode.AiKey,
    command: `${CLI} secret set ${names.join(" ")}`,
    note: `AI for ${listed(using)}`,
    why: `${listed(using)} ${using.length === 1 ? "uses" : "use"} AI once ${listed(names)} ${names.length === 1 ? "is" : "are"} set; no AI key is set on the Gateway.`,
  };
}

/**
 * An MCP app's key is set and the app is off: offer its tools. Not while
 * a deployed app lists the provider's capability (OpenSEO lists
 * `dataforseo`): the key is set for that app, and an operator who wants
 * no AI client spending the provider's credit would read this forever.
 */
function providerOffers(facts: NextFacts): NextStep[] {
  const { gatewayNames, providers, uploaded, apps } = facts;
  if (!gatewayNames || !uploaded) return [];
  return providers
    .filter(
      (provider) =>
        !provider.on &&
        gatewayNames.includes(provider.keySetting) &&
        appsListing(apps, provider.capability).length === 0,
    )
    .map((provider) => ({
      code: NextCode.ProviderOffer,
      command: `${CLI} mcp on ${provider.id}`,
      note: `offer ${provider.name}'s tools to AI clients (each call spends ${provider.name} credit)`,
      why: `${provider.keySetting} is set and ${provider.name} is off.`,
    }));
}

/**
 * An MCP app is on and its key isn't set: it serves nothing until it is.
 * The command is `secret set`, as the SDK's `setupCommand` gives it for a
 * provider row: `configure <app>` reads a deployed Worker's manifest, and
 * an MCP app has no Worker (`findRegisteredApp` refuses its id).
 */
function providerKeys(facts: NextFacts): NextStep[] {
  const { gatewayNames, providers, apps } = facts;
  if (!gatewayNames) return [];
  return providers
    .filter(
      (provider) =>
        provider.on &&
        !gatewayNames.includes(provider.keySetting) &&
        !fixNames(apps, provider.keySetting),
    )
    .map((provider) => ({
      code: NextCode.ProviderKey,
      command: `${CLI} secret set ${provider.keySetting}`,
      note: `${provider.name} is on and needs its key`,
      why: `${provider.name} shows "needs setup" and serves no tools until ${provider.keySetting} is set.`,
    }));
}

/**
 * Self-hosted, uploaded, claimed, Access read and off. A hosted Gateway
 * ignores Access; before the claim `access on` refuses (nobody to let in,
 * ACCESS_NOBODY_ALLOWED), and the fix above says `setup`.
 */
function accessOff(facts: NextFacts): NextStep | null {
  const { mode, uploaded, owner, access } = facts;
  if (mode === "hosted" || !uploaded || !owner || !access || access.on) return null;
  return {
    code: NextCode.AccessOff,
    command: `${CLI} access on`,
    note: "put Cloudflare Access in front (recommended)",
    why: "Cloudflare Access is off; the Gateway's own sign-in is the only check in front of your apps.",
  };
}

/** One member, nobody invited yet, and an app to open. */
function invite(facts: NextFacts): NextStep | null {
  const { counts, owner, apps, gatewayUrl } = facts;
  if (!counts || !owner || counts.members !== 1 || counts.invitations > 0 || !apps.some(isServed)) {
    return null;
  }
  return {
    code: NextCode.Invite,
    url: `${gatewayUrl}/admin/users`,
    note: "invite people",
    why: `${owner.email} is the only member.`,
  };
}

/**
 * No AI client connected and no personal token live, while apps serve
 * tools. The page is the connector steps: `/mcp` itself answers a GET
 * with 405 (`packages/toolbus/src/http.ts`), so it is the note's.
 */
function connectAi(facts: NextFacts): NextStep | null {
  const { counts, gatewayUrl } = facts;
  if (!counts || counts.connections > 0 || counts.tokens > 0 || counts.toolApps === 0) return null;
  return {
    code: NextCode.ConnectAi,
    url: CONNECT_AI_DOCS,
    note: `connect an AI client to ${gatewayUrl}/mcp`,
    why: `No AI client is connected; ${plural(counts.toolApps, "app")} ${counts.toolApps === 1 ? "serves" : "serve"} tools.`,
  };
}

/** An uploaded Gateway with no apps. */
function createApp(facts: NextFacts): NextStep | null {
  if (!facts.uploaded || facts.apps.length > 0) return null;
  return {
    code: NextCode.CreateApp,
    command: `${CLI} create my-app`,
    note: "start your first app",
    why: "No apps yet.",
  };
}

/**
 * No sender on the Gateway (`EMAIL_FROM`; the name may be inside it, so
 * `EMAIL_FROM_NAME` alone decides nothing), while there are people to
 * invite or an app that sends mail. An app whose email capability is
 * required has its fix already.
 */
function emailUnset(facts: NextFacts): NextStep | null {
  const { gatewayNames, counts, apps } = facts;
  if (!gatewayNames || gatewayNames.includes("EMAIL_FROM") || fixNames(apps, "EMAIL_FROM")) {
    return null;
  }
  const sending = appsListing(apps, "email").filter(
    (id) => !apps.some((app) => app.id === id && needsSetup(app)),
  );
  const several = (counts?.members ?? 0) > 1;
  if (!several && sending.length === 0) return null;
  return {
    code: NextCode.EmailUnset,
    command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
    note: "email invites and password resets; needs Cloudflare Email Sending",
    why: `No sender is set: invites and resets go out by link${
      sending.length > 0
        ? `, and ${listed(sending)} ${sending.length === 1 ? "sends" : "send"} mail once there is one`
        : ""
    }.`,
  };
}

/**
 * The steps, in the design's order, the first four. A step whose command
 * a fix already gives is dropped: the fix is the place for it.
 */
export function nextStepsFor(facts: NextFacts): NextStep[] {
  const steps = [
    aiKey(facts),
    ...providerOffers(facts),
    ...providerKeys(facts),
    accessOff(facts),
    invite(facts),
    connectAi(facts),
    createApp(facts),
    emailUnset(facts),
  ].filter((step): step is NextStep => step !== null);
  return steps
    .filter((step) => !step.command || !facts.problems.some((p) => p.run?.text === step.command))
    .slice(0, NEXT_STEPS_MAX);
}
