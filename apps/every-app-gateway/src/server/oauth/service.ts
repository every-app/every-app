/**
 * The OAuth providers service (docs/design/2026-10-oauth-providers.md):
 * what Admin → Providers, Settings → Connected accounts, the CLI's twins
 * on the Gateway and the `everyapp_provider_*` tools call. Adding,
 * replacing a client, removing a provider, listing every connection and
 * disconnecting someone else's account are an owner's or admin's; a
 * person's own connections are theirs. Nothing here returns a token or a
 * client secret.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { parseSecretNames } from "@every-app/perimeter/registry";
import {
  aiRequiredSettings,
  CAPABILITY_IDS,
  capabilitySettings,
  checkProviderRow,
  describeSpecProblems,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  secretNames,
  type Capability,
  type OAuthClientCapability,
  type ProviderRegistry,
  type ProviderRow,
} from "@every-app/sdk/internal";
import { gatewaySettingIsSet } from "@/server/ai-default";
import { appSettingsReport } from "@/server/app-setup";
import { emit } from "@/server/events/bus";
import { catalogue, type EventActor } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import {
  gatewayProviders,
  invalidateGatewayProviders,
  refusedGatewayHost,
  registryFromRows,
} from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OAuthClientRepository } from "@/server/repositories/OAuthClientRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { SealingUnavailableError } from "@/server/secrets/sealed";
import { resolveOAuthClient } from "./client";
import { flowOf, revokeAtProvider, type Fetch } from "./tokens";

type FlowKind = "app" | "gateway" | "both";
export type ProviderKind = "api_key" | "oauth" | "ai" | "service";

/** One OAuth provider as Admin → Providers and `provider list` show it. */
export interface OAuthProviderSummary {
  id: string;
  name: string;
  source: "catalog" | "row";
  kind: "oauth";
  flow: FlowKind;
  /** Where the live client comes from, or null when none is usable. */
  client: {
    source: "env" | "d1" | null;
    clientId?: string;
    addedBy?: string | null;
    addedAt?: number | null;
    /** A D1 client exists but was uploaded for other endpoints, or no longer opens. */
    stale?: boolean;
  };
  /** Whether a client is live for the provider as it is now. */
  bound: boolean;
  redirectUri: string;
  scopeSets: { name: string; label: string; access: "read" | "write" }[];
  /** Where the operator registers the client. */
  console: string;
  /** How many connections the organization has at it. */
  connections: number;
  docs?: string;
  /** The Gateway setting names a terminal `secret set` uses for the client. */
  settings: string[];
}

/** Any registry entry, for the Admin list beside the OAuth ones. */
export interface ProviderSummary {
  id: string;
  name: string;
  source: "catalog" | "row";
  kind: ProviderKind;
  hosts: string[];
  /**
   * Whether its credential is set: an AI or API-key provider's every
   * Gateway setting it needs (a registered row's only while bound), an
   * OAuth provider's live client from either source. Never a value.
   */
  configured: boolean;
  /** The Gateway settings it needs, by name: what `everyapp secret set` takes. */
  settings: string[];
  /** The organization's apps that list it, and whether it keeps each one closed. */
  apps: { name: string; needs: boolean }[];
  /** For an OAuth provider, its full summary. */
  oauth?: OAuthProviderSummary;
}

/** One connection as the lists show it: never a token. */
export interface ConnectionSummary {
  id: string;
  providerId: string;
  providerName: string;
  account: "user" | "organization";
  userId?: string;
  userEmail?: string | null;
  label: string | null;
  scopeSets: string[];
  status: "active" | "expired";
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

type ServiceEnv = typeof env;

function gatewayUrl(settings: ServiceEnv = env): string {
  const raw = (settings as { GATEWAY_URL?: string }).GATEWAY_URL ?? "";
  return raw.replace(/\/+$/, "");
}

/** The redirect URI the operator registers at the provider's console. */
export function redirectUriFor(
  providerId: string,
  settings: ServiceEnv = env,
): string {
  return `${gatewayUrl(settings)}/connect/${encodeURIComponent(providerId)}/callback`;
}

/** The path the UI links a Connect button to. */
export function connectStartUrl(
  _org: OrgContext,
  providerId: string,
  options: {
    account: "user" | "organization";
    returnTo?: string;
    sets?: readonly string[];
  },
): string {
  const params = new URLSearchParams({ account: options.account });
  if (options.returnTo) params.set("return", options.returnTo);
  if (options.sets && options.sets.length > 0) {
    params.set("sets", options.sets.join(","));
  }
  return `/connect/${encodeURIComponent(providerId)}?${params.toString()}`;
}

function flowKind(capability: OAuthClientCapability): FlowKind {
  return flowOf(capability) ? "both" : "app";
}

function requireAdmin(org: OrgContext): void {
  if (org.role !== "owner" && org.role !== "admin") {
    throw new PublicError(
      "ADMIN_REQUIRED",
      "Only an owner or admin can manage OAuth providers",
    );
  }
}

function isBuiltinId(id: string): boolean {
  return (
    id === "everyapp" || (CAPABILITY_IDS as readonly string[]).includes(id)
  );
}

function manifestOf(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function capabilityIdsOf(manifest: Record<string, unknown> | null): string[] {
  const capabilities = manifest?.["capabilities"];
  return capabilities && typeof capabilities === "object"
    ? Object.keys(capabilities)
    : [];
}

function scopeSetsOf(
  capability: OAuthClientCapability,
): OAuthProviderSummary["scopeSets"] {
  return Object.entries(capability.scopePolicy?.sets ?? {}).map(
    ([name, set]) => ({ name, label: set.label, access: set.access }),
  );
}

async function clientSummary(
  id: string,
  capability: OAuthClientCapability,
  registry: ProviderRegistry,
): Promise<OAuthProviderSummary["client"] & { bound: boolean }> {
  const live = await resolveOAuthClient({
    id,
    capability,
    env: env as never,
    lookup: registry,
  });
  const stored = await OAuthClientRepository.get(id);
  if (live) {
    return {
      source: live.source,
      clientId: live.clientId,
      bound: true,
      ...(live.source === "d1" && stored
        ? { addedBy: stored.addedBy, addedAt: stored.addedAt }
        : {}),
    };
  }
  if (stored) {
    return {
      source: null,
      clientId: stored.clientId,
      addedBy: stored.addedBy,
      addedAt: stored.addedAt,
      stale: true,
      bound: false,
    };
  }
  return { source: null, bound: false };
}

async function oauthSummary(
  org: OrgContext,
  id: string,
  capability: OAuthClientCapability,
  registry: ProviderRegistry,
  counts: Record<string, number>,
): Promise<OAuthProviderSummary> {
  const { bound, ...client } = await clientSummary(id, capability, registry);
  return {
    id,
    name: capability.label,
    source: registry.sourceOf(id) === "row" ? "row" : "catalog",
    kind: "oauth",
    flow: flowKind(capability),
    client,
    bound,
    redirectUri: redirectUriFor(id),
    scopeSets: scopeSetsOf(capability),
    console: capability.console,
    connections: counts[id] ?? 0,
    ...(capability.reference ? { docs: capability.reference } : {}),
    settings: [...capabilitySettings(capability)],
  };
}

function kindOf(capability: Capability): ProviderKind {
  switch (capability.mode) {
    case "api_key":
      return "api_key";
    case "oauth_client":
      return "oauth";
    case "ai":
      return "ai";
    default:
      return "service";
  }
}

function hostsOf(capability: Capability): string[] {
  switch (capability.mode) {
    case "api_key":
      return [...capability.hosts];
    case "oauth_client":
      return [...capability.api];
    default:
      return [];
  }
}

/** Every OAuth provider on this gateway: the catalog's clients and the registered rows. */
export async function listOAuthProviders(
  org: OrgContext,
): Promise<OAuthProviderSummary[]> {
  const registry = await gatewayProviders();
  const counts = await ProviderConnectionRepository.countByProvider(org.orgId);
  const out: OAuthProviderSummary[] = [];
  for (const [id, capability] of registry.entries()) {
    if (capability.mode !== "oauth_client") continue;
    out.push(await oauthSummary(org, id, capability, registry, counts));
  }
  return out;
}

/** The Gateway settings an entry needs: the AI default's rule for a model provider. */
function neededSettings(capability: Capability): string[] {
  switch (capability.mode) {
    case "ai":
      return aiRequiredSettings(capability);
    case "service":
      return [...capability.settings];
    default:
      return [...capabilitySettings(capability)];
  }
}

/**
 * Whether an AI, API-key or service entry's settings are all set, as the
 * proxies read them; a registered row's count only while its key is bound
 * to the hosts it has now.
 */
function settingsConfigured(
  id: string,
  settings: readonly string[],
  registry: ProviderRegistry,
): boolean {
  if (!registry.bound(id)) return false;
  const unbound = registry.unboundSettings();
  return settings.every(
    (name) => !unbound.has(name) && gatewaySettingIsSet(name),
  );
}

/**
 * Which of the organization's apps list each provider or capability, by
 * the setup evaluation the app lists run (cached per row and version), and
 * whether that setting keeps the app closed. One app's evaluation failing
 * leaves it out, as the lists do.
 */
async function appsByProvider(
  org: OrgContext,
): Promise<Map<string, ProviderSummary["apps"]>> {
  const out = new Map<string, ProviderSummary["apps"]>();
  for (const app of await AppRepository.findAll(org.orgId)) {
    const report = await appSettingsReport({
      rowId: app.id,
      versionId: app.versionId,
      secretNames: parseSecretNames(app.secretNames),
      appId: app.appSlug,
      tier: app.tier,
      manifest: app.manifest,
      canFix: true,
    }).catch(() => null);
    for (const setting of report?.settings ?? []) {
      if (setting.kind !== "provider" && setting.kind !== "capability") {
        continue;
      }
      out.set(setting.id, [
        ...(out.get(setting.id) ?? []),
        { name: app.name, needs: setting.blocking },
      ]);
    }
  }
  return out;
}

/** Every registry entry, for the Admin list. */
export async function listProviders(
  org: OrgContext,
): Promise<ProviderSummary[]> {
  const registry = await gatewayProviders();
  const counts = await ProviderConnectionRepository.countByProvider(org.orgId);
  const apps = await appsByProvider(org);
  const out: ProviderSummary[] = [];
  for (const [id, capability] of registry.entries()) {
    const summary: ProviderSummary = {
      id,
      name: capability.mode === "service" ? id : capability.label,
      source: registry.sourceOf(id) === "row" ? "row" : "catalog",
      kind: kindOf(capability),
      hosts: hostsOf(capability),
      configured: false,
      settings: neededSettings(capability),
      apps: apps.get(id) ?? [],
    };
    if (capability.mode === "oauth_client") {
      summary.oauth = await oauthSummary(org, id, capability, registry, counts);
      summary.configured = summary.oauth.client.source !== null;
    } else {
      summary.configured = settingsConfigured(id, summary.settings, registry);
    }
    out.push(summary);
  }
  return out;
}

/** The OAuth capability `id` names on this gateway, or a refusal. */
export async function oauthCapability(
  id: string,
): Promise<{ capability: OAuthClientCapability; registry: ProviderRegistry }> {
  const registry = await gatewayProviders();
  const capability = registry.get(id);
  if (!capability) {
    throw new PublicError(
      "PROVIDER_NOT_FOUND",
      `No provider ${id} is on this Gateway`,
    );
  }
  if (capability.mode !== "oauth_client") {
    throw new PublicError(
      "OAUTH_PROVIDER_REQUIRED",
      `${id} is not an OAuth provider`,
    );
  }
  return { capability, registry };
}

async function actorFor(
  org: OrgContext,
  actor: EventActor | null | undefined,
): Promise<EventActor> {
  return actor ?? (await userActor(org.userId));
}

/** The MCP tool's checks for a new row, as one function the service and the UI share. */
async function checkNewRow(
  id: string,
  capability: Capability,
  rows: ProviderRow[],
): Promise<void> {
  if (isBuiltinId(id)) {
    throw new PublicError(
      "PROVIDER_BUILTIN",
      `${id} is a built-in provider; a registered one can't take its id`,
    );
  }
  if (rows.some((row) => row.id === id)) {
    throw new PublicError(
      "PROVIDER_EXISTS",
      `${id} is registered on this Gateway already`,
    );
  }
  if (capability.mode !== "api_key" && capability.mode !== "oauth_client") {
    throw new PublicError("PROVIDER_SPEC_INVALID", "not a registrable kind");
  }
  const others = registryFromRows(rows);
  const refusal = checkProviderRow(id, capability, {
    rowSettings: new Set(
      others.rows().flatMap((row) => capabilitySettings(row.capability)),
    ),
    refuseHost: (host) => refusedGatewayHost(host, env as never),
  });
  if (refusal) throw new PublicError(refusal.code, refusal.message);
  const settings = capabilitySettings(capability);
  for (const app of await AppRepository.findAllManifests()) {
    const manifest = manifestOf(app.manifest);
    if (!manifest) continue;
    const own = secretNames(manifest as Parameters<typeof secretNames>[0]).map(
      (name) => name.toUpperCase(),
    );
    const taken = settings.filter((name) => own.includes(name));
    if (taken.length > 0) {
      throw new PublicError(
        "PROVIDER_SECRET_TAKEN",
        `${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} ${app.appSlug}'s own secret, so a provider can't read ${taken.length === 1 ? "it" : "them"} from the Gateway`,
      );
    }
  }
}

async function storeClient(
  id: string,
  capability: OAuthClientCapability,
  input: { clientId: string; clientSecret?: string | null },
  addedBy: string,
): Promise<void> {
  const clientId = input.clientId.trim();
  if (!clientId) {
    throw new PublicError("INVALID_INPUT", "A client id is required");
  }
  const secret = input.clientSecret?.trim() || null;
  if (capability.secrets.clientSecret && !secret) {
    throw new PublicError(
      "OAUTH_CLIENT_REQUIRED",
      `${capability.label} is a confidential client: paste its client secret too`,
    );
  }
  try {
    await OAuthClientRepository.upsert(
      {
        providerId: id,
        clientId,
        clientSecret: secret,
        boundTo: providerBindingKey(capability),
        addedBy,
      },
      env as never,
    );
  } catch (error) {
    if (error instanceof SealingUnavailableError) {
      throw new PublicError(
        "SEALING_UNAVAILABLE",
        "This Gateway can't seal a secret: BETTER_AUTH_SECRET is not set",
      );
    }
    throw error;
  }
}

/**
 * Add an OAuth provider: a preset becomes a registered row (a catalog
 * OAuth entry takes the client only), a spec of the `oauth2-user` kind
 * becomes a row; with a client id (and secret), the client is sealed into
 * D1 at once. Returns the provider as the list shows it.
 */
export async function addOAuthProvider(
  org: OrgContext,
  actor: EventActor | null | undefined,
  input: {
    preset?: string;
    spec?: unknown;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<OAuthProviderSummary> {
  requireAdmin(org);
  const who = await actorFor(org, actor);
  // The caller's email: the member's, or the one the agent acts for.
  const addedBy =
    ((who.kind === "user" || who.kind === "agent") && who.email) || org.userId;
  let id: string;
  let capability: OAuthClientCapability;
  let rowSpec: unknown = null;
  if (input.preset) {
    const existing = (await gatewayProviders()).get(input.preset);
    if (existing?.mode === "oauth_client" && isBuiltinId(input.preset)) {
      id = input.preset;
      capability = existing;
    } else {
      const preset = OAUTH_PRESETS[input.preset];
      if (!preset) {
        throw new PublicError(
          "PROVIDER_NOT_FOUND",
          `No OAuth preset ${input.preset}; see the presets list`,
        );
      }
      rowSpec = preset;
      const parsed = parseProviderSpec(preset);
      if (!parsed.ok || parsed.capability.mode !== "oauth_client") {
        throw new PublicError(
          "PROVIDER_SPEC_INVALID",
          "the preset is not valid",
        );
      }
      id = parsed.id;
      capability = parsed.capability;
    }
  } else if (input.spec !== undefined) {
    const text = JSON.stringify(input.spec);
    if (!text || text.length > 64 * 1024) {
      throw new PublicError(
        "INVALID_INPUT",
        "spec must be an object under 64 KiB",
      );
    }
    const parsed = parseProviderSpec(input.spec);
    if (!parsed.ok) {
      throw new PublicError(
        "PROVIDER_SPEC_INVALID",
        describeSpecProblems(parsed.problems),
      );
    }
    if (parsed.capability.mode !== "oauth_client") {
      throw new PublicError(
        "OAUTH_PROVIDER_REQUIRED",
        "The spec's auth.kind must be oauth2-user; API-key providers are added with everyapp provider add",
      );
    }
    rowSpec = input.spec;
    id = parsed.id;
    capability = parsed.capability;
  } else {
    throw new PublicError("INVALID_INPUT", "Give a preset or a spec");
  }

  if (rowSpec !== null) {
    const rows = await ProviderRepository.all();
    await checkNewRow(id, capability, rows);
    const written = await ProviderRepository.insert({
      id,
      spec: JSON.stringify(rowSpec),
      addedBy,
    });
    if (!written) {
      throw new PublicError(
        "PROVIDER_EXISTS",
        `${id} was registered on this Gateway while this ran`,
      );
    }
    invalidateGatewayProviders();
    logEvent("provider.added", {
      provider: id,
      org: org.orgId,
      user_id: org.userId,
      via: "ui",
    });
    await emit(async () => ({
      organizationId: org.orgId,
      actor: who,
      ...catalogue.providerAdded({
        provider: { id, name: capability.label, kind: "oauth" },
      }),
    }));
  }
  if (input.clientId) {
    await storeClient(
      id,
      capability,
      { clientId: input.clientId, clientSecret: input.clientSecret ?? null },
      addedBy,
    );
    logEvent("provider.client_set", {
      provider: id,
      org: org.orgId,
      user_id: org.userId,
    });
    await emit(async () => ({
      organizationId: org.orgId,
      actor: who,
      ...catalogue.providerUpdated({
        provider: { id, name: capability.label, kind: "oauth" },
        change: "client",
      }),
    }));
  }
  const registry = await gatewayProviders();
  const counts = await ProviderConnectionRepository.countByProvider(org.orgId);
  return oauthSummary(org, id, capability, registry, counts);
}

/** Upload or replace a provider's client (sealed in D1). */
export async function setOAuthClient(
  org: OrgContext,
  actor: EventActor | null | undefined,
  providerId: string,
  input: { clientId: string; clientSecret?: string | null },
): Promise<OAuthProviderSummary> {
  requireAdmin(org);
  const who = await actorFor(org, actor);
  const { capability, registry } = await oauthCapability(providerId);
  await storeClient(
    providerId,
    capability,
    input,
    (who.kind === "user" && who.email) || org.userId,
  );
  logEvent("provider.client_set", {
    provider: providerId,
    org: org.orgId,
    user_id: org.userId,
  });
  await emit(async () => ({
    organizationId: org.orgId,
    actor: who,
    ...catalogue.providerUpdated({
      provider: { id: providerId, name: capability.label, kind: "oauth" },
      change: "client",
    }),
  }));
  const counts = await ProviderConnectionRepository.countByProvider(org.orgId);
  return oauthSummary(org, providerId, capability, registry, counts);
}

/** Forget the D1 client (a Worker-secret client stays the terminal's to unset). */
export async function removeOAuthClient(
  org: OrgContext,
  actor: EventActor | null | undefined,
  providerId: string,
): Promise<boolean> {
  requireAdmin(org);
  const who = await actorFor(org, actor);
  const { capability } = await oauthCapability(providerId);
  const removed = await OAuthClientRepository.remove(providerId);
  if (removed) {
    logEvent("provider.client_removed", {
      provider: providerId,
      org: org.orgId,
      user_id: org.userId,
    });
    await emit(async () => ({
      organizationId: org.orgId,
      actor: who,
      ...catalogue.providerUpdated({
        provider: { id: providerId, name: capability.label, kind: "oauth" },
        change: "client",
      }),
    }));
  }
  return removed;
}

/**
 * Remove a registered provider: refused while an app lists it or a
 * terminal-set key is bound to it; its D1 client and every connection go
 * with it.
 */
export async function removeProvider(
  org: OrgContext,
  actor: EventActor | null | undefined,
  providerId: string,
): Promise<void> {
  requireAdmin(org);
  const who = await actorFor(org, actor);
  if (isBuiltinId(providerId)) {
    throw new PublicError(
      "PROVIDER_BUILTIN",
      `${providerId} is built in; only a registered provider can be removed`,
    );
  }
  const rows = await ProviderRepository.all();
  const row = rows.find((each) => each.id === providerId);
  if (!row) {
    throw new PublicError(
      "PROVIDER_NOT_FOUND",
      `No provider ${providerId} is registered on this Gateway`,
    );
  }
  const registered = registryFromRows(rows)
    .rows()
    .find((each) => each.id === providerId);
  if (row.boundTo) {
    const settings = registered
      ? capabilitySettings(registered.capability)
      : [];
    throw new PublicError(
      "PROVIDER_BOUND",
      `${providerId}'s settings are set from the terminal; remove it there: everyapp provider remove ${providerId}, then everyapp secret unset ${settings.join(" ") || "<its settings>"}`,
    );
  }
  const apps = (await AppRepository.findAllManifests())
    .filter((app) =>
      capabilityIdsOf(manifestOf(app.manifest)).includes(providerId),
    )
    .map((app) => app.appSlug);
  if (apps.length > 0) {
    throw new PublicError(
      "PROVIDER_IN_USE",
      `${apps.join(", ")} ${apps.length === 1 ? "lists" : "list"} ${providerId} under capabilities; remove it from ${apps.length === 1 ? "that app" : "those apps"} first`,
    );
  }
  const removed = await ProviderRepository.removeUnbound(providerId);
  if (!removed) {
    throw new PublicError(
      "PROVIDER_BOUND",
      `${providerId} changed on this Gateway while this ran`,
    );
  }
  await OAuthClientRepository.remove(providerId);
  await ProviderConnectionRepository.removeAllForProvider(providerId);
  invalidateGatewayProviders();
  logEvent("provider.removed", {
    provider: providerId,
    org: org.orgId,
    user_id: org.userId,
    via: "ui",
  });
  await emit(async () => ({
    organizationId: org.orgId,
    actor: who,
    ...catalogue.providerRemoved({
      provider: {
        id: providerId,
        name: registered?.capability.label ?? providerId,
        kind:
          registered?.capability.mode === "oauth_client" ? "oauth" : "api_key",
      },
    }),
  }));
}

/** The person's own connections, or with `user: "all"` (owner or admin) the organization's. */
export async function listConnections(
  org: OrgContext,
  options: { user?: string | "all" } = {},
): Promise<ConnectionSummary[]> {
  const who = options.user ?? org.userId;
  if (who !== org.userId) requireAdmin(org);
  const registry = await gatewayProviders();
  const rows = (
    await ProviderConnectionRepository.listByOrganization(org.orgId)
  ).filter((row) =>
    who === "all" ? true : row.accountKind === "user" && row.userId === who,
  );
  const out: ConnectionSummary[] = [];
  for (const row of rows) {
    const name = registry.get(row.providerId);
    const summary: ConnectionSummary = {
      id: row.id,
      providerId: row.providerId,
      providerName:
        name && name.mode !== "service" ? name.label : row.providerId,
      account: row.accountKind,
      label: row.label,
      scopeSets: row.scopeSets,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
    };
    if (row.userId) {
      summary.userId = row.userId;
      try {
        summary.userEmail = (await userSubject(row.userId)).email ?? null;
      } catch {
        summary.userEmail = null;
      }
    }
    out.push(summary);
  }
  return out;
}

/**
 * Disconnect an account: a person's own on any role, anyone's or the
 * organization's for an owner or admin. Revokes at the provider when the
 * flow names a revoke endpoint and a client is live.
 */
export async function disconnect(
  org: OrgContext,
  actor: EventActor | null | undefined,
  input: {
    providerId: string;
    account: "user" | "organization";
    userId?: string;
  },
  fetchUpstream: Fetch = (request) => fetch(request),
): Promise<{ removed: boolean; revoked: boolean }> {
  const userId = input.account === "user" ? (input.userId ?? org.userId) : null;
  if (input.account === "organization" || userId !== org.userId) {
    requireAdmin(org);
  }
  const who = await actorFor(org, actor);
  const subject = input.account === "user" ? userId! : "organization";
  const connection = await ProviderConnectionRepository.find(
    org.orgId,
    input.providerId,
    subject,
  );
  if (!connection) {
    throw new PublicError("CONNECTION_NOT_FOUND", "No such connection");
  }
  const registry = await gatewayProviders();
  const capability = registry.get(input.providerId);
  let revoked = false;
  if (capability?.mode === "oauth_client" && flowOf(capability)?.revokeUrl) {
    const client = await resolveOAuthClient({
      id: input.providerId,
      capability,
      env: env as never,
      lookup: registry,
    });
    const tokens = await ProviderConnectionRepository.readTokens(
      connection.id,
      env as never,
    );
    if (client && tokens) {
      revoked = await revokeAtProvider({
        capability,
        client,
        accessToken: tokens.accessToken,
        fetchUpstream,
        log: { provider: input.providerId, org: org.orgId },
      });
    }
  }
  const removed = await ProviderConnectionRepository.remove(connection.id);
  logEvent("provider.disconnected", {
    provider: input.providerId,
    org: org.orgId,
    user_id: org.userId,
    account: input.account,
    revoked,
  });
  const member = userId ? await userSubject(userId).catch(() => null) : null;
  await emit(async () => ({
    organizationId: org.orgId,
    actor: who,
    ...catalogue.providerDisconnected({
      provider: {
        id: input.providerId,
        name:
          capability && capability.mode !== "service"
            ? capability.label
            : input.providerId,
        kind: "oauth",
      },
      account: {
        kind: input.account,
        ...(member
          ? { user: { id: member.id, email: member.email, name: member.name } }
          : userId
            ? { user: { id: userId } }
            : {}),
        label: connection.label,
      },
      revoked,
    }),
  }));
  return { removed, revoked };
}
