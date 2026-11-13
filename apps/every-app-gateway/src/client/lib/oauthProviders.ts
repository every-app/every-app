import {
  isRemoteMcpProviderIdOf,
  providerSettingPrefix,
} from "@every-app/sdk/internal";
import { productKey, productName } from "./productNames";

/**
 * Pure helpers behind Manage workspace → Providers and Your connections →
 * Accounts (docs/design/2026-11-oauth-simplify.md): the words
 * each state reads as, and the custom provider's spec. Tested without
 * React.
 */

/** The custom provider form's values, as the Add dialog takes them. */
interface CustomProviderForm {
  name: string;
  id: string;
  console: string;
  authorizeUrl: string;
  tokenUrl: string;
  hosts: string;
  scopeSeparator: "space" | "comma";
  inject: "form" | "basic";
  pkce: boolean;
}

/** A connection's scopes as a line: the provider's own names, or "no scopes". */
export function scopesText(scopes: readonly string[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "no scopes";
}

/** What Your connections → Accounts needs of a connection to name and order it. */
interface ListedConnection {
  providerId: string;
  providerName: string;
  label: string | null;
  apps: readonly { id: string; name: string }[];
  needsReconnect: boolean;
}

/** The app whose own remote MCP server (`<app>-mcp`) this connection is to, if one is allowed to use it. */
function ownApp<C extends ListedConnection>(
  connection: C,
): C["apps"][number] | undefined {
  return connection.apps.find((app) =>
    isRemoteMcpProviderIdOf(connection.providerId, app.id),
  );
}

/**
 * How a connection reads in a list: the account's name, the line under it
 * (how the provider names the account, when it does), and the id its brand
 * mark is listed under. An app's own remote MCP server (`<app>-mcp`) is
 * named after the app that uses it ("elevenlabs-mcp MCP server" reads as
 * "ElevenLabs"), and an app nobody named (its name is still its id) by the
 * product's own spelling when the id is a known product's ("stripe" reads
 * as "Stripe").
 */
export function connectionName(connection: ListedConnection): {
  title: string;
  subtitle: string | null;
  mark: string;
  /** An app's own MCP server, for where there is room to say so. */
  mcp: boolean;
} {
  const owner = ownApp(connection);
  if (!owner) {
    return {
      title: connection.providerName,
      subtitle: connection.label,
      mark: connection.providerId,
      mcp: false,
    };
  }
  const unnamed = owner.name.toLowerCase() === owner.id.toLowerCase();
  return {
    title: (unnamed ? productName(owner.id) : null) ?? owner.name,
    subtitle: connection.label,
    mark: productKey(owner.id),
    mcp: true,
  };
}

/**
 * The apps worth naming under a connection: everyone allowed to use it,
 * except when that is only the app whose own MCP server it is ("Context,
 * used by Context" says nothing).
 */
export function appsToName<C extends ListedConnection>(
  connection: C,
): C["apps"] {
  const owner = ownApp(connection);
  return connection.apps.length === 1 && owner ? [] : connection.apps;
}

/** "OpenMail", "OpenMail and Scribe", "OpenMail, Scribe and CRM". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Scopes that only say who the person is or keep them signed in, which every sign-in asks for. */
const IDENTITY_SCOPES = new Set([
  "openid",
  "offline_access",
  "email",
  "profile",
  "userinfo.email",
  "userinfo.profile",
]);

/** Google's products, by the first word of a scope ("gmail.modify"). */
const GOOGLE_PRODUCTS: ReadonlyMap<string, string> = new Map([
  ["gmail", "Gmail"],
  ["calendar", "Calendar"],
  ["drive", "Drive"],
  ["documents", "Docs"],
  ["spreadsheets", "Sheets"],
  ["presentations", "Slides"],
  ["contacts", "Contacts"],
  ["tasks", "Tasks"],
  ["forms", "Forms"],
  ["chat", "Chat"],
  ["meetings", "Meet"],
  ["webmasters", "Search Console"],
  ["analytics", "Analytics"],
]);

function permissionCount(count: number): string {
  return count === 1 ? "1 permission" : `${count} permissions`;
}

/** Whether a scope is plainly a read ("api.read", "read_user", "calendar.readonly") or a write, or neither. */
function readOrWrite(scope: string): "read" | "write" | null {
  const words = scope.toLowerCase().split(/[^a-z]+/);
  const read = words.some((word) => word === "read" || word === "readonly");
  const write = words.includes("write");
  if (read === write) return null;
  return read ? "read" : "write";
}

/**
 * What a connection's scopes let its apps do, in a few plain words, where
 * the scopes say so themselves: Google's by product ("Calendar and
 * Gmail"), and a list made only of reads and writes as "Read only" or
 * "Read and write". Anything else is a count ("9 permissions"): a scope
 * name this can't read isn't guessed at, and the full list is a click
 * away. Scopes that only identify the person are left out, and a
 * connection with nothing else holds a "Basic profile".
 */
export function accessSummary(connection: {
  providerId: string;
  scopes: readonly string[];
}): string {
  const scopes = connection.scopes.filter(
    (scope) => !IDENTITY_SCOPES.has(scope.toLowerCase()),
  );
  if (scopes.length === 0) {
    return connection.scopes.length > 0 ? "Basic profile" : "None";
  }
  if (connection.providerId === "google-workspace") {
    const products = scopes.map((scope) =>
      GOOGLE_PRODUCTS.get(scope.toLowerCase().split(".")[0]!),
    );
    if (products.every((product) => product !== undefined)) {
      return namesText([...new Set(products)].sort());
    }
    return permissionCount(scopes.length);
  }
  const kinds = scopes.map(readOrWrite);
  if (kinds.includes(null)) return permissionCount(scopes.length);
  if (!kinds.includes("write")) return "Read only";
  return kinds.includes("read") ? "Read and write" : "Write only";
}

/**
 * How much of what the person's apps list a connection holds, when it is
 * less than all of it: "10 of 18 granted". Null when everything listed was
 * granted, or no app lists anything. Granting part is the person's choice
 * (or all the provider gives), so this reads as a fact, not a fault.
 */
export function partialGrant(connection: {
  permissions?: { listed: number; granted: number } | null;
}): string | null {
  const permissions = connection.permissions;
  if (!permissions || permissions.granted >= permissions.listed) return null;
  return `${permissions.granted} of ${permissions.listed} granted`;
}

/**
 * A connection's Access cell: what it lets apps do in a few words, and how
 * much was granted when that is part of what its apps list ("Read only",
 * then "10 of 18 granted"). Where the words are only a count, the share
 * granted is the count worth saying: "10 of 18 permissions".
 */
export function accessWords(connection: {
  providerId: string;
  scopes: readonly string[];
  permissions?: { listed: number; granted: number } | null;
}): { words: string; partial: string | null } {
  const words = accessSummary(connection);
  const partial = partialGrant(connection);
  if (partial && /^\d+ permissions?$/.test(words)) {
    const { granted, listed } = connection.permissions!;
    return { words: `${granted} of ${listed} permissions`, partial: null };
  }
  return { words, partial };
}

/** The list order: connections that need reconnecting first, then by name. */
export function compareConnections(
  a: ListedConnection,
  b: ListedConnection,
): number {
  return (
    Number(b.needsReconnect) - Number(a.needsReconnect) ||
    connectionName(a).title.localeCompare(connectionName(b).title) ||
    (a.label ?? "").localeCompare(b.label ?? "")
  );
}

/** A space- or comma-separated field as a list, blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const SLUG = /[^a-z0-9-]+/g;

/** `Acme Cloud` → `acme-cloud`, for the id a custom provider gets by default. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(SLUG, "")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

/** A provider spec (./oauthSpec.ts in the SDK) from the custom form's values. */
export function customSpecOf(
  value: CustomProviderForm,
): Record<string, unknown> {
  const prefix = providerSettingPrefix(value.id);
  return {
    id: value.id,
    name: value.name,
    docs: value.console,
    hosts: splitList(value.hosts).map((host) => host.toLowerCase()),
    auth: {
      kind: "oauth2-user",
      authorizeUrl: value.authorizeUrl,
      tokenUrl: value.tokenUrl,
      clientId: `${prefix}CLIENT_ID`,
      clientSecret: `${prefix}CLIENT_SECRET`,
      inject: value.inject,
      pkce: value.pkce,
      scopeSeparator: value.scopeSeparator,
    },
  };
}
