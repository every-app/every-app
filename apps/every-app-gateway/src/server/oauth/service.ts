/**
 * The OAuth providers service
 * (docs/design/2026-11-oauth-one-connection.md): what Manage workspace →
 * Providers, Your connections → Accounts and the `everyapp_provider_*` tools
 * call. Adding a provider, replacing its client, removing it, listing
 * every connection and disconnecting someone else's are an owner's or
 * admin's; a person's own connections are theirs. A connection is one
 * person's to one provider, used by the apps that person allowed. Nothing
 * here returns a token or a client secret.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { parseSecretNames } from "@every-app/perimeter/registry";
import {
  aiRequiredSettings,
  capabilitySettings,
  checkProviderRow,
  describeSpecProblems,
  isPresetRow,
  OAUTH_PRESETS,
  oauthPreset,
  parseProviderSpec,
  providerBindingKey,
  secretNames,
  unregisteredPresetIds,
  type Capability,
  type CapabilityLookup,
  type OAuthClientCapability,
  type ProviderRegistry,
  type ProviderRow,
} from "@every-app/sdk/internal";
import { gatewaySettingIsSet } from "@/server/ai-default";
import { resolveDeploymentMode } from "@/server/deployment-mode";
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
import { ProviderAppAccessRepository as Access } from "@/server/repositories/ProviderAppAccessRepository";
import {
  ProviderConnectionRepository as Connections,
  type ProviderConnection,
} from "@/server/repositories/ProviderConnectionRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { SealingUnavailableError } from "@/server/secrets/sealed";
import {
  connectionAction,
  declaredScopes,
  memberAppByRow,
  parseManifest,
} from "./appAccess";
import { resolveOAuthClient } from "./client";
import { revokeAtProvider, type Fetch } from "./tokens";

export type ProviderKind = "api_key" | "oauth" | "ai" | "service";

/** One OAuth provider as Admin → Providers and `provider list` show it. */
export interface OAuthProviderSummary {
  id: string;
  name: string;
  source: "catalog" | "row";
  kind: "oauth";
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
  /** The only hosts the Gateway sends a held token to. */
  hosts: string[];
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
  /** The organization's apps that list it (apps.id, name), and whether it keeps each one closed. */
  apps: { rowId: string; name: string; needs: boolean }[];
  /**
   * A registered row whose key was set from the terminal: removing it is
   * the terminal's too (`everyapp provider remove`, then `secret unset`).
   */
  setFromTerminal: boolean;
  /**
   * Whether any app on this Gateway, in any organization, lists it under
   * capabilities: Remove provider is refused while one does. Never which
   * apps, since another organization's are not this one's to see.
   */
  inUse: boolean;
  /** For an OAuth provider, its full summary. */
  oauth?: OAuthProviderSummary;
}

/** An app the person allowed to use a connection, as the lists name it. */
export interface ConnectionApp {
  /** apps.id. */
  rowId: string;
  /** The app's id (its slug). */
  id: string;
  name: string;
}

/** One connection as the lists show it: one person's, to one provider; never a token. */
export interface ConnectionSummary {
  id: string;
  providerId: string;
  providerName: string;
  userId: string;
  userEmail: string | null;
  /** The apps the person allowed to use it, by name. An app that is gone is left out. */
  apps: ConnectionApp[];
  /** How the provider names the account ("ben@example.com"). */
  label: string | null;
  /** The scopes the token holds, as the Gateway compares them (the provider's prefix taken off). */
  scopes: string[];
  status: "active" | "expired";
  /**
   * An app the person allowed needs them to select Reconnect: the
   * connection expired, lacks a scope the app lists now, or the app lists
   * more than the person allowed it.
   */
  needsReconnect: boolean;
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

function requireAdmin(org: OrgContext): void {
  if (org.role !== "owner" && org.role !== "admin") {
    throw new PublicError(
      "ADMIN_REQUIRED",
      "Only an owner or admin can manage OAuth providers",
    );
  }
}

function capabilityIdsOf(manifest: Record<string, unknown> | null): string[] {
  const capabilities = manifest?.["capabilities"];
  return capabilities && typeof capabilities === "object"
    ? Object.keys(capabilities)
    : [];
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
    client,
    bound,
    redirectUri: redirectUriFor(id),
    hosts: [...capability.api],
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

/** Every OAuth provider on this gateway: its registered rows. */
export async function listOAuthProviders(
  org: OrgContext,
): Promise<OAuthProviderSummary[]> {
  const registry = await gatewayProviders();
  const counts = await Connections.countByProvider(org.orgId);
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
        { rowId: app.id, name: app.name, needs: setting.blocking },
      ]);
    }
  }
  return out;
}

/**
 * The apps on this Gateway, every organization's, that list each provider
 * under capabilities, by provider id (app slugs): what Remove provider is
 * refused for, and what the Admin list marks in use.
 */
async function appsListingProviders(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const app of await AppRepository.findAllManifests()) {
    for (const id of capabilityIdsOf(parseManifest(app.manifest))) {
      out.set(id, [...(out.get(id) ?? []), app.appSlug]);
    }
  }
  return out;
}

/** Every registry entry, for the Admin list. */
export async function listProviders(
  org: OrgContext,
): Promise<ProviderSummary[]> {
  const registry = await gatewayProviders();
  const counts = await Connections.countByProvider(org.orgId);
  const apps = await appsByProvider(org);
  const listing = await appsListingProviders();
  const terminalRows = new Set(
    (await ProviderRepository.all())
      .filter((row) => row.boundTo)
      .map((row) => row.id),
  );
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
      setFromTerminal: terminalRows.has(id),
      inUse: listing.has(id),
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
  if (rows.some((row) => row.id === id)) {
    throw new PublicError(
      "PROVIDER_EXISTS",
      `${id} is registered on this Gateway already`,
    );
  }
  if (
    capability.mode !== "api_key" &&
    capability.mode !== "oauth_client" &&
    capability.mode !== "ai"
  ) {
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
    const manifest = parseManifest(app.manifest);
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

/**
 * The OAuth presets `manifest` lists under `capabilities` that this
 * Gateway has no row for: checked as new rows now, and the lookup that
 * serves them as their rows would, for the manifest's check; `register`
 * writes the rows, once the deploy or install goes ahead. What a hosted
 * deploy and a browser install run, as `everyapp deploy` does from the
 * terminal, so an app that lists `google-workspace` needs no step but its
 * client. Refusals are the new-row rules' (PublicError).
 *
 * Self-hosted only. Rows are gateway-wide, so on a hosted gateway a
 * tenant's deploy registers nothing (the rule `registersProviders` and
 * the providers server functions follow): a manifest that lists a preset
 * with no row is refused (PROVIDER_HOSTED) until the platform's operator
 * registers it with `everyapp provider add`.
 */
export async function planPresetProviders(
  manifest: unknown,
  base?: CapabilityLookup,
): Promise<{
  lookup: CapabilityLookup;
  register: (who: {
    organizationId: string;
    userId: string;
    email: string;
  }) => Promise<void>;
}> {
  const registry = base ?? (await gatewayProviders());
  const listed =
    manifest && typeof manifest === "object"
      ? capabilityIdsOf(manifest as Record<string, unknown>)
      : [];
  const ids = unregisteredPresetIds(listed, registry);
  if (ids.length === 0) return { lookup: registry, register: async () => {} };
  if (resolveDeploymentMode(env.GATEWAY_DEPLOYMENT_MODE) !== "self_hosted") {
    throw new PublicError(
      "PROVIDER_HOSTED",
      `${ids.join(", ")} ${ids.length === 1 ? "isn't" : "aren't"} registered on this Gateway. On a hosted gateway the platform's operator registers providers.`,
    );
  }
  const rows = await ProviderRepository.all();
  const planned = new Map<string, OAuthClientCapability>();
  for (const id of ids) {
    if (rows.some((row) => row.id === id)) continue;
    const capability = oauthPreset(id);
    if (capability?.mode !== "oauth_client") continue;
    await checkNewRow(id, capability, rows);
    planned.set(id, capability);
  }
  return {
    lookup: {
      get: (id) => registry.get(id) ?? planned.get(id),
      ids: () => [...registry.ids(), ...planned.keys()],
    },
    register: async (who) => {
      for (const [id, capability] of planned) {
        const written = await ProviderRepository.insert({
          id,
          spec: JSON.stringify(OAUTH_PRESETS[id]),
          addedBy: who.email,
        });
        // Another deploy wrote it meanwhile: its row serves.
        if (!written) continue;
        logEvent("provider.added", {
          provider: id,
          org: who.organizationId,
          user_id: who.userId,
          via: "preset",
        });
        await emit(async () => ({
          organizationId: who.organizationId,
          actor: await userActor(who.userId),
          ...catalogue.providerAdded({
            provider: { id, name: capability.label, kind: "oauth" },
          }),
        }));
      }
      if (planned.size > 0) invalidateGatewayProviders();
    },
  };
}

async function storeClient(
  id: string,
  capability: OAuthClientCapability,
  input: { clientId: string; clientSecret?: string | null },
  addedBy: string,
): Promise<void> {
  const clientId = input.clientId.trim();
  if (!clientId) {
    throw new PublicError("INVALID_INPUT", "A client ID is required");
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
 * Add an OAuth provider: a preset becomes a registered row (one already
 * registered, as a deploy registers the presets its app lists, takes the
 * client only), a spec of the `oauth2-user` kind becomes a row; with a
 * client id (and secret), the client is sealed into D1 at once. Returns
 * the provider as the list shows it.
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
    if (
      existing?.mode === "oauth_client" &&
      isPresetRow(input.preset, existing)
    ) {
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
  const counts = await Connections.countByProvider(org.orgId);
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
  const counts = await Connections.countByProvider(org.orgId);
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
  const apps = (await appsListingProviders()).get(providerId) ?? [];
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
  await Connections.removeAllForProvider(providerId);
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

/** An app an access row names, with its deployed manifest. */
interface AccessApp {
  app: ConnectionApp;
  manifest: Record<string, unknown> | null;
}

/** The apps access rows name, by row id: the organization's, and any shared app one names. An app that is gone has no entry. */
async function appsByRow(
  org: OrgContext,
  rowIds: Iterable<string>,
): Promise<Map<string, AccessApp>> {
  const out = new Map<string, AccessApp>();
  const add = (app: {
    id: string;
    appSlug: string;
    name: string;
    manifest: string | null;
  }) =>
    out.set(app.id, {
      app: { rowId: app.id, id: app.appSlug, name: app.name },
      manifest: parseManifest(app.manifest),
    });
  for (const app of await AppRepository.findAll(org.orgId)) add(app);
  for (const rowId of new Set(rowIds)) {
    if (out.has(rowId)) continue;
    const app = await AppRepository.findCallableById(rowId, org.orgId);
    if (app) add(app);
  }
  return out;
}

/**
 * Whether Reconnect has something to do for the connection: an app the
 * person allowed, still opens and that still lists the provider (as
 * Reconnect itself reads them, flow.ts) needs more than it has.
 */
async function needsReconnect(
  capability: Capability | undefined,
  row: ProviderConnection,
  allowed: readonly (AccessApp & { scopes: string[] })[],
): Promise<boolean> {
  if (capability?.mode !== "oauth_client") return false;
  for (const each of allowed) {
    const declared = declaredScopes(each.manifest, row.providerId);
    if (
      declared === null ||
      connectionAction(capability.flow, row, each, declared) === null
    ) {
      continue;
    }
    if (await memberAppByRow({ ...row, appRowId: each.app.rowId })) return true;
  }
  return false;
}

async function summarize(
  org: OrgContext,
  rows: readonly ProviderConnection[],
): Promise<ConnectionSummary[]> {
  const registry = await gatewayProviders();
  const access = await Access.listByOrganization(org.orgId);
  const apps = await appsByRow(
    org,
    access.map((each) => each.appRowId),
  );
  const out: ConnectionSummary[] = [];
  for (const row of rows) {
    const capability = registry.get(row.providerId);
    const member = await userSubject(row.userId).catch(() => null);
    const allowed = access.flatMap((each) => {
      const named = apps.get(each.appRowId);
      return each.providerId === row.providerId &&
        each.userId === row.userId &&
        named
        ? [{ ...named, scopes: each.scopes }]
        : [];
    });
    out.push({
      id: row.id,
      providerId: row.providerId,
      providerName:
        capability && capability.mode !== "service"
          ? capability.label
          : row.providerId,
      userId: row.userId,
      userEmail: member?.email ?? null,
      apps: allowed
        .map((each) => each.app)
        .sort((a, b) => a.name.localeCompare(b.name)),
      label: row.label,
      scopes: [...row.scopes],
      status: row.status,
      needsReconnect: await needsReconnect(capability, row, allowed),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
    });
  }
  return out;
}

/**
 * The person's own connections, or with `user` another member's or
 * `"all"` the organization's (owner or admin); `providerId` narrows to one
 * provider.
 */
export async function listConnections(
  org: OrgContext,
  options: { user?: string | "all"; providerId?: string } = {},
): Promise<ConnectionSummary[]> {
  const who = options.user ?? org.userId;
  if (who !== org.userId) requireAdmin(org);
  const rows = (await Connections.listByOrganization(org.orgId)).filter(
    (row) =>
      (who === "all" || row.userId === who) &&
      (!options.providerId || row.providerId === options.providerId),
  );
  return summarize(org, rows);
}

/** How a disconnect or an app's removal names a connection: by its id, or by provider and person (default the caller). */
export type ConnectionRef =
  | { connectionId: string }
  | { providerId: string; userId?: string };

/**
 * The connection `input` names, which the caller may change: their own on
 * any role, anyone's in the organization for an owner or admin.
 */
async function connectionFor(
  org: OrgContext,
  input: ConnectionRef,
): Promise<ProviderConnection> {
  if (
    !("connectionId" in input) &&
    (input.userId ?? org.userId) !== org.userId
  ) {
    requireAdmin(org);
  }
  const row =
    "connectionId" in input
      ? await Connections.byId(input.connectionId)
      : await Connections.find({
          organizationId: org.orgId,
          providerId: input.providerId,
          userId: input.userId ?? org.userId,
        });
  if (!row || row.organizationId !== org.orgId) {
    throw new PublicError("CONNECTION_NOT_FOUND", "No such connection");
  }
  if (row.userId !== org.userId) requireAdmin(org);
  return row;
}

/**
 * Take one app's access to a connection away (`app`: its id or row id):
 * a person's own on any role, anyone's for an owner or admin. The
 * connection stays for the other apps, and the app asks the person again
 * before it uses it.
 */
export async function removeAppAccess(
  org: OrgContext,
  input: ConnectionRef & { app: string },
): Promise<{ removed: boolean; connection: ConnectionSummary }> {
  const connection = await connectionFor(org, input);
  const [before] = await summarize(org, [connection]);
  const app = before!.apps.find(
    (each) => each.id === input.app || each.rowId === input.app,
  );
  if (!app) {
    throw new PublicError(
      "CONNECTION_NOT_FOUND",
      `${input.app} isn't allowed to use this connection`,
    );
  }
  const removed = await Access.remove({
    organizationId: connection.organizationId,
    providerId: connection.providerId,
    userId: connection.userId,
    appRowId: app.rowId,
  });
  logEvent("provider.app_access_removed", {
    provider: connection.providerId,
    org: org.orgId,
    user_id: org.userId,
    app_row_id: app.rowId,
  });
  return {
    removed,
    connection: {
      ...before!,
      apps: before!.apps.filter((each) => each.rowId !== app.rowId),
    },
  };
}

/**
 * Disconnect a connection: a person's own on any role, anyone's for an
 * owner or admin. Every app they allowed stops using it at once. Revokes
 * at the provider when its flow names a revoke endpoint and a client is
 * live, then drops the tokens.
 */
export async function disconnect(
  org: OrgContext,
  actor: EventActor | null | undefined,
  input: ConnectionRef,
  fetchUpstream: Fetch = (request) => fetch(request),
): Promise<{
  removed: boolean;
  revoked: boolean;
  connection: ConnectionSummary;
}> {
  const connection = await connectionFor(org, input);
  const who = await actorFor(org, actor);
  const [summary] = await summarize(org, [connection]);
  const registry = await gatewayProviders();
  const capability = registry.get(connection.providerId);
  let revoked = false;
  if (capability?.mode === "oauth_client" && capability.flow.revokeUrl) {
    const client = await resolveOAuthClient({
      id: connection.providerId,
      capability,
      env: env as never,
      lookup: registry,
    });
    const tokens = await Connections.readTokens(connection.id, env as never);
    if (client && tokens) {
      revoked = await revokeAtProvider({
        capability,
        client,
        tokens,
        fetchUpstream,
        log: { provider: connection.providerId, org: org.orgId },
      });
    }
  }
  const removed = await Connections.remove(connection);
  logEvent("provider.disconnected", {
    provider: connection.providerId,
    org: org.orgId,
    user_id: org.userId,
    revoked,
  });
  const member = await userSubject(connection.userId).catch(() => null);
  await emit(async () => ({
    organizationId: org.orgId,
    actor: who,
    ...catalogue.providerDisconnected({
      provider: {
        id: connection.providerId,
        name: summary!.providerName,
        kind: "oauth",
      },
      account: {
        user: member
          ? { id: member.id, email: member.email, name: member.name }
          : { id: connection.userId },
        label: connection.label,
      },
      revoked,
    }),
  }));
  return { removed, revoked, connection: summary! };
}
