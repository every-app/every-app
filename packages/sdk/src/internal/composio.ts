/**
 * Composio, as far as the settings model and the Gateway need to agree on
 * it (docs/design/2026-11-composio.md): which OAuth providers it serves,
 * the services each one is there, the provider scopes and URLs a service
 * covers, and the one rule for whether a provider an app lists is set up.
 * Data, and its readers. Nothing here calls Composio.
 *
 * Composio calls a connected service a toolkit. Most providers are one.
 * Google, Microsoft 365 and Atlassian are several, each with its own
 * account there, so a scope an app lists and a URL it calls both have to
 * be read as one of them. A scope or a URL no rule matches has no service:
 * the app isn't served through Composio, and the call is refused, never
 * guessed.
 */
import type { OAuthFlow } from "./capabilities.js";
import { canonicalScope } from "./oauthScopes.js";

/** How a connection was made, and how a provider is served: with the Gateway's OAuth client, or through a person's Composio. */
export enum ConnectionVia {
  OAuth = "oauth",
  Composio = "composio",
}

/** The scope rules of a provider's flow that decide which scopes are sign-in ones. */
type ScopeRules = Pick<
  OAuthFlow,
  "scopeSeparator" | "scopePrefix" | "identityScopes" | "tolerated"
>;

/** The URLs one service owns on a host: all of them, or the paths named. */
interface UrlRule {
  host: string;
  /** Paths owned with everything under them (`/calendar/`, `/me/drive`). */
  under?: readonly string[];
  /** Paths owned as written, and nothing under them (`/me` itself). */
  exact?: readonly string[];
}

interface Service {
  /** Composio's name for the service. */
  slug: string;
  /** What a person calls it ("Gmail"). */
  label: string;
  /**
   * The provider scopes it covers, canonical (lower case, the provider's
   * prefix taken off); `*` stands for any run of characters.
   */
  scopes: readonly string[];
  urls: readonly UrlRule[];
}

interface ServedProvider {
  services: readonly Service[];
  /**
   * A leading part of every path that names no service (Microsoft Graph's
   * `/v1.0`), taken off before the rules are read.
   */
  versionPrefix?: RegExp;
}

/** A provider that is one service: every scope and every URL on its hosts is that service's. */
function single(slug: string, label: string, hosts: string[]): ServedProvider {
  return {
    services: [
      { slug, label, scopes: ["*"], urls: hosts.map((host) => ({ host })) },
    ],
  };
}

const SERVED: Readonly<Record<string, ServedProvider>> = {
  "github-oauth": single("github", "GitHub", ["api.github.com"]),
  slack: single("slack", "Slack", ["slack.com"]),
  "notion-oauth": single("notion", "Notion", ["api.notion.com"]),
  "linear-oauth": single("linear", "Linear", ["api.linear.app"]),
  "gitlab-oauth": single("gitlab", "GitLab", ["gitlab.com"]),
  "hubspot-oauth": single("hubspot", "HubSpot", ["api.hubapi.com"]),
  zoom: single("zoom", "Zoom", ["api.zoom.us"]),
  dropbox: single("dropbox", "Dropbox", [
    "api.dropboxapi.com",
    "content.dropboxapi.com",
  ]),
  "google-workspace": {
    services: [
      {
        slug: "gmail",
        label: "Gmail",
        scopes: ["gmail.*", "https://mail.google.com/"],
        urls: [{ host: "gmail.googleapis.com" }],
      },
      {
        slug: "googlecalendar",
        label: "Calendar",
        scopes: ["calendar", "calendar.*"],
        urls: [{ host: "www.googleapis.com", under: ["/calendar/"] }],
      },
      {
        slug: "googledrive",
        label: "Drive",
        scopes: ["drive", "drive.*"],
        urls: [
          { host: "www.googleapis.com", under: ["/drive/", "/upload/drive/"] },
        ],
      },
      {
        slug: "googlesheets",
        label: "Sheets",
        scopes: ["spreadsheets", "spreadsheets.*"],
        urls: [{ host: "sheets.googleapis.com" }],
      },
      {
        slug: "googledocs",
        label: "Docs",
        scopes: ["documents", "documents.*"],
        urls: [{ host: "docs.googleapis.com" }],
      },
      {
        slug: "google_search_console",
        label: "Search Console",
        scopes: ["webmasters", "webmasters.*"],
        urls: [
          { host: "searchconsole.googleapis.com" },
          { host: "www.googleapis.com", under: ["/webmasters/"] },
        ],
      },
      {
        slug: "google_analytics",
        label: "Analytics",
        scopes: ["analytics", "analytics.*"],
        urls: [
          { host: "analyticsdata.googleapis.com" },
          { host: "analyticsadmin.googleapis.com" },
        ],
      },
    ],
  },
  "microsoft-365": {
    versionPrefix: /^\/(v1\.0|beta)(?=\/|$)/,
    services: [
      {
        slug: "outlook",
        label: "Outlook",
        scopes: ["mail.*", "mailboxsettings.*", "calendars.*", "contacts.*"],
        urls: [
          {
            host: "graph.microsoft.com",
            exact: ["/me"],
            under: [
              "/me/messages",
              "/me/mailFolders",
              "/me/sendMail",
              "/me/events",
              "/me/calendar",
              "/me/calendars",
              "/me/calendarView",
              "/me/calendarGroups",
              "/me/contacts",
              "/me/contactFolders",
            ],
          },
        ],
      },
      {
        slug: "one_drive",
        label: "OneDrive",
        scopes: ["files.*"],
        urls: [
          {
            host: "graph.microsoft.com",
            under: ["/me/drive", "/me/drives", "/drives"],
          },
        ],
      },
      {
        slug: "microsoft_teams",
        label: "Teams",
        scopes: [
          "team.*",
          "teammember.*",
          "teamsettings.*",
          "channel.*",
          "channelmessage.*",
          "channelmember.*",
          "channelsettings.*",
          "chat.*",
          "chatmessage.*",
          "chatmember.*",
        ],
        urls: [
          {
            host: "graph.microsoft.com",
            under: ["/teams", "/chats", "/me/joinedTeams"],
          },
        ],
      },
      {
        slug: "share_point",
        label: "SharePoint",
        scopes: ["sites.*"],
        urls: [{ host: "graph.microsoft.com", under: ["/sites"] }],
      },
    ],
  },
  atlassian: {
    services: [
      {
        slug: "jira",
        label: "Jira",
        scopes: ["*jira*"],
        urls: [{ host: "api.atlassian.com", under: ["/ex/jira/"] }],
      },
      {
        slug: "confluence",
        label: "Confluence",
        scopes: ["*confluence*"],
        urls: [{ host: "api.atlassian.com", under: ["/ex/confluence/"] }],
      },
    ],
  },
};

/** A service of a provider as a person reads it. */
export interface ComposioService {
  /** Composio's name for the service (`gmail`). */
  slug: string;
  /** What a person calls it ("Gmail"). */
  label: string;
}

/** Whether a path is `prefix` itself or continues it at a `/`. */
function isUnder(path: string, prefix: string): boolean {
  return (
    path === prefix ||
    path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}

function owns(rule: UrlRule, host: string, path: string): boolean {
  if (rule.host !== host) return false;
  if (!rule.under && !rule.exact) return true;
  return (
    (rule.exact ?? []).includes(path) ||
    (rule.under ?? []).some((prefix) => isUnder(path, prefix))
  );
}

/** Whether `scope` (canonical) is one `pattern` names; `*` is any run of characters. */
function covers(pattern: string, scope: string): boolean {
  const literal = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${pattern.split("*").map(literal).join(".*")}$`).test(
    scope,
  );
}

/** Whether Composio can serve the provider. */
export function composioServes(providerId: string): boolean {
  return Object.hasOwn(SERVED, providerId);
}

/** Every provider Composio can serve, by id. */
export function composioProviderIds(): string[] {
  return Object.keys(SERVED);
}

/** A provider's services at Composio, in its own order; none for a provider Composio doesn't serve. */
export function composioServicesOf(providerId: string): ComposioService[] {
  if (!composioServes(providerId)) return [];
  return SERVED[providerId]!.services.map(({ slug, label }) => ({
    slug,
    label,
  }));
}

/** Every Composio service a provider here maps to, by slug: what the account list is asked for. */
export function composioServiceSlugs(): string[] {
  return Object.values(SERVED).flatMap((served) =>
    served.services.map((service) => service.slug),
  );
}

/** The Composio service that owns `url` for the provider, or null when no rule says. */
export function composioServiceFor(
  providerId: string,
  url: URL,
): string | null {
  if (!composioServes(providerId)) return null;
  const served = SERVED[providerId]!;
  const path = served.versionPrefix
    ? url.pathname.replace(served.versionPrefix, "")
    : url.pathname;
  const owner = served.services.find((service) =>
    service.urls.some((rule) => owns(rule, url.host, path)),
  );
  return owner?.slug ?? null;
}

/** Whether a scope only signs the person in (`openid`, `User.Read`): it needs no service. */
function isSignInScope(rules: ScopeRules, scope: string): boolean {
  return [...rules.identityScopes, ...rules.tolerated].some(
    (each) => canonicalScope(rules, each) === scope,
  );
}

/** The service a scope an app lists belongs to: its slug, null for a sign-in scope, undefined when no service covers it. */
function serviceOfScope(
  served: ServedProvider,
  rules: ScopeRules,
  declared: string,
): string | null | undefined {
  const scope = canonicalScope(rules, declared);
  const owner = served.services.find((service) =>
    service.scopes.some((pattern) => covers(pattern, scope)),
  );
  if (owner) return owner.slug;
  return isSignInScope(rules, scope) ? null : undefined;
}

/**
 * The services an app that lists `declared` needs at Composio, in the
 * provider's order. Null when Composio can't serve the app: it doesn't
 * serve the provider, a scope the app lists belongs to no service, or the
 * app lists nothing that names one of a provider's several services. A
 * provider that is one service always needs it.
 */
export function composioServicesNeeded(
  providerId: string,
  rules: ScopeRules,
  declared: readonly string[],
): string[] | null {
  if (!composioServes(providerId)) return null;
  const served = SERVED[providerId]!;
  if (served.services.length === 1) return [served.services[0]!.slug];
  const needed = new Set<string>();
  for (const scope of declared) {
    const slug = serviceOfScope(served, rules, scope);
    if (slug === undefined) return null;
    if (slug !== null) needed.add(slug);
  }
  if (needed.size === 0) return null;
  return served.services
    .map((service) => service.slug)
    .filter((slug) => needed.has(slug));
}

/**
 * The scopes of `declared` a connection through Composio doesn't hold:
 * those whose service has no account among `services`, and those no
 * service covers. The counterpart of `missingScopes` for a connection
 * that holds services and not scopes.
 */
export function composioMissingScopes(
  providerId: string,
  rules: ScopeRules,
  services: readonly string[],
  declared: readonly string[],
): string[] {
  if (!composioServes(providerId)) return [...declared];
  const served = SERVED[providerId]!;
  const one = served.services.length === 1 ? served.services[0]!.slug : null;
  return declared.filter((scope) => {
    const slug = one ?? serviceOfScope(served, rules, scope);
    if (slug === null) return false;
    return slug === undefined || !services.includes(slug);
  });
}

/** The scope strings a manifest's `capabilities` entry for a provider lists, as the app wrote them. */
export function manifestScopes(
  manifest: unknown,
  providerId: string,
): string[] {
  const entry = (
    manifest as { capabilities?: Record<string, unknown> } | null | undefined
  )?.capabilities?.[providerId];
  const scopes =
    entry && typeof entry === "object"
      ? (entry as { scopes?: unknown }).scopes
      : undefined;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/**
 * How an OAuth provider is served in an organization, or null when it
 * isn't: with the Gateway's own client whenever it holds one, else through
 * Composio when the organization turned it on and Composio serves the
 * provider. A provider is served one way.
 */
export function oauthServing(input: {
  providerId: string;
  /** The Gateway holds a client it may use (`oauthClientSource` is not null). */
  clientHeld: boolean;
  /** The organization turned Composio on. */
  composioOn: boolean;
}): ConnectionVia | null {
  if (input.clientHeld) return ConnectionVia.OAuth;
  return input.composioOn && composioServes(input.providerId)
    ? ConnectionVia.Composio
    : null;
}

/**
 * Whether an OAuth provider an app lists is set up: the Gateway holds a
 * client for it, or Composio is on for the organization, serves it, and
 * has a service for every scope the app lists. One rule for every surface
 * that asks, beside `oauthClientSource`: the gate that opens an app, the
 * app lists, a call, and the CLI's `status`, `deploy` and `configure`.
 */
export function oauthProviderSetUp(input: {
  providerId: string;
  rules: ScopeRules;
  /** The scopes the app lists for the provider, as it wrote them. */
  declared: readonly string[];
  clientHeld: boolean;
  composioOn: boolean;
}): boolean {
  switch (oauthServing(input)) {
    case ConnectionVia.OAuth:
      return true;
    case ConnectionVia.Composio:
      return (
        composioServicesNeeded(
          input.providerId,
          input.rules,
          input.declared,
        ) !== null
      );
    default:
      return false;
  }
}

/** What Composio is, in the one sentence said wherever it is first offered. */
export const COMPOSIO_IS =
  "Composio is a third-party service where you connect your accounts.";

/** What turning Composio on means, said before every Yes. */
export const COMPOSIO_NOTICE =
  "Requests to the accounts people use from Composio pass through Composio.";

/** Composio's dashboard: where a person approves a sign-in. */
export const COMPOSIO_DASHBOARD_URL = "https://dashboard.composio.dev";

/**
 * Where a person connects a service in their own Composio: the service's
 * page in the dashboard, which has `~/~` where their organization and
 * project would be.
 */
export function composioServiceUrl(slug: string): string {
  return `${COMPOSIO_DASHBOARD_URL}/~/~/connect/apps/${encodeURIComponent(slug)}`;
}
