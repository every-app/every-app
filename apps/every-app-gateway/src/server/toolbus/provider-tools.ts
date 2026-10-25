/**
 * The handlers behind the provider tools on the gateway's own /mcp
 * (`everyapp_provider_list`, `everyapp_provider_add`,
 * `everyapp_provider_remove`; docs/design/2026-10-provider-registry.md,
 * section 8), run like the workspace tools (workspace-tools.ts spreads
 * them into its handler map) for a resolved caller.
 *
 * The ToolBus has already listed each tool to the caller's role and
 * access, hidden the two writers where the gateway doesn't register
 * providers (`WorkspaceHost.providers`: hosted), and checked the arguments
 * against the tool's schema. The rules that decide whether a row may exist
 * are the SDK's (`checkProviderRow`, the same the CLI runs before it
 * writes and the gateway runs on every read); this file adds what the
 * gateway alone can check (no registered app holds a row's setting as a
 * secret of its own; no deployed manifest lists a row that is removed)
 * and the two refusals that keep key movement an operator's path: `add`
 * never replaces a row, `remove` never takes a row whose key is set
 * (`providers.value-bound-to-hosts`). No answer carries a value: the list
 * says whether a setting is set, the key is set from the terminal.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  CAPABILITIES,
  capabilitySettings,
  CAPABILITY_IDS,
  checkProviderRow,
  describeSpecProblems,
  isOAuthProvider,
  oauthPreset,
  oauthPresetIds,
  parseProviderSpec,
  secretNames,
  type ApiKeyAuth,
  type Capability,
  type OAuthClientCapability,
  type ProviderRow,
  type RegisteredProvider,
} from "@every-app/sdk/internal";
import type { JsonObject, McpPrincipal } from "@every-app/toolbus";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor } from "@/server/events/subjects";
import { PublicError } from "@/server/errors";
import {
  addOAuthProvider,
  listOAuthProviders,
  type OAuthProviderSummary,
} from "@/server/oauth/service";
import type { OrgContext } from "@/server/organization/orgContext";
import {
  gatewayProviders,
  invalidateGatewayProviders,
  refusedGatewayHost,
  registryFromRows,
} from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";

type Handler = (
  ctx: OrgContext,
  args: JsonObject,
  principal: McpPrincipal,
) => Promise<JsonObject>;

/** The longest spec `add` takes, as `everyapp provider add <url>` reads one. */
const SPEC_MAX_BYTES = 64 * 1024;

/** The ids no row may take: the catalog's and the gateway's own. */
function isBuiltinId(id: string): boolean {
  return (
    id === "everyapp" || (CAPABILITY_IDS as readonly string[]).includes(id)
  );
}

/** A tool error the caller can act on, `CODE: message`. */
function refuse(code: string, message: string): JsonObject {
  return { error: `${code}: ${message}` };
}

/** A deployed manifest's text as an object, or null. */
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

/** The capability ids a manifest lists. */
function capabilityIdsOf(manifest: Record<string, unknown> | null): string[] {
  const capabilities = manifest?.["capabilities"];
  return capabilities && typeof capabilities === "object"
    ? Object.keys(capabilities)
    : [];
}

/**
 * The rows read, or the reason they can't be: a gateway whose database
 * predates migration 0010 has no table, and the tools say so rather than
 * answering on the catalog alone.
 */
async function rowsOrOutdated(): Promise<
  { rows: ProviderRow[] } | { error: JsonObject }
> {
  try {
    return { rows: await ProviderRepository.all() };
  } catch {
    return {
      error: refuse(
        "GATEWAY_OUTDATED",
        "this Gateway's database has no providers table yet; its operator runs: everyapp update",
      ),
    };
  }
}

/** Where the key goes, without the setting's name (the settings list has it). */
function authSummary(auth: ApiKeyAuth): JsonObject {
  switch (auth.kind) {
    case "bearer":
      return {
        kind: "bearer",
        ...(auth.scheme ? { scheme: auth.scheme } : {}),
      };
    case "header":
      return {
        kind: "header",
        header: auth.header,
        ...(auth.prefix ? { prefix: auth.prefix } : {}),
      };
    case "query":
      return { kind: "query", param: auth.param };
    case "basic":
      return { kind: "basic", as: auth.as };
  }
}

/** Whether a Gateway setting holds a value, as the proxies read it. */
function isSet(name: string, unbound: ReadonlySet<string>): boolean {
  if (unbound.has(name)) return false;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

/** One provider as `everyapp_provider_list` reports it. */
function listed(
  id: string,
  capability: Capability,
  source: "catalog" | "row" | undefined,
  row: RegisteredProvider | undefined,
  options: {
    admin: boolean;
    unbound: ReadonlySet<string>;
    apps: readonly string[];
    /** The OAuth service's summary of the entry, when it runs the flow for one. */
    oauth?: OAuthProviderSummary;
  },
): JsonObject {
  const hints = new Map<string, string>();
  if (capability.mode === "api_key" || capability.mode === "ai") {
    for (const secret of capability.secrets ?? []) {
      if (secret.hint) hints.set(secret.name, secret.hint);
    }
  }
  const settings = capabilitySettings(capability).map((name) => ({
    name,
    ...(hints.has(name) ? { hint: hints.get(name) } : {}),
    ...(options.admin ? { set: isSet(name, options.unbound) } : {}),
  }));
  const base: JsonObject = {
    id,
    name: capability.label,
    kind: capability.mode,
    source: source ?? "catalog",
    settings,
    apps: [...options.apps],
  };
  switch (capability.mode) {
    case "api_key":
      return {
        ...base,
        auth: authSummary(capability.auth),
        hosts: [...capability.hosts],
        ...(capability.hostSetting
          ? { hostSetting: capability.hostSetting }
          : {}),
        access: [...capability.access],
        docs: capability.docs,
        ...(capability.hint ? { hint: capability.hint } : {}),
        ...(capability.data ? { data: capability.data } : {}),
        ...(row
          ? {
              addedBy: row.addedBy,
              addedAt:
                row.addedAt === null
                  ? null
                  : new Date(row.addedAt).toISOString(),
              ...(options.admin ? { bound: row.bound } : {}),
            }
          : {}),
      };
    case "ai":
      return {
        ...base,
        auth: authSummary(capability.auth),
        origin: capability.origin,
        docs: capability.docs,
        ...(capability.hint ? { hint: capability.hint } : {}),
      };
    case "oauth_client": {
      const oauth = options.oauth;
      return {
        ...base,
        auth: { kind: oauth ? "oauth2-user" : "oauth_client" },
        ...(capability.hostSetting
          ? { hostSetting: capability.hostSetting }
          : {}),
        docs: capability.console,
        hosts: [...capability.api],
        ...(oauth
          ? {
              flow: oauth.flow,
              redirectUri: oauth.redirectUri,
              console: oauth.console,
              scopeSets: oauth.scopeSets.map((set) => ({ ...set })),
              connections: oauth.connections,
              connectPath: `/connect/${id}`,
              ...(options.admin
                ? {
                    client: {
                      source: oauth.client.source,
                      ...(oauth.client.clientId
                        ? { clientId: oauth.client.clientId }
                        : {}),
                      ...(oauth.client.stale ? { stale: true } : {}),
                    },
                    bound: oauth.bound,
                  }
                : { client: { set: oauth.bound } }),
            }
          : {}),
        ...(row && !oauth
          ? {
              addedBy: row.addedBy,
              addedAt:
                row.addedAt === null
                  ? null
                  : new Date(row.addedAt).toISOString(),
            }
          : {}),
      };
    }
    case "service":
      return base;
  }
}

/** The OAuth presets `provider_add { preset }` takes: the catalog's clients with a flow (built in), then the SDK's presets. */
function presetsListed(): JsonObject[] {
  const one = (
    id: string,
    capability: OAuthClientCapability,
    builtIn: boolean,
  ): JsonObject => ({
    id,
    name: capability.label,
    builtIn,
    console: capability.console,
    hosts: [...capability.api],
    settings: [...capabilitySettings(capability)],
    scopeSets: Object.entries(capability.scopePolicy?.sets ?? {}).map(
      ([name, set]) => ({ name, label: set.label, access: set.access }),
    ),
    ...(capability.hint ? { hint: capability.hint } : {}),
  });
  const builtIn = Object.entries(CAPABILITIES)
    .filter(([, capability]) => isOAuthProvider(capability as Capability))
    .map(([id, capability]) =>
      one(id, capability as OAuthClientCapability, true),
    );
  const presets = oauthPresetIds().flatMap((id) => {
    const capability = oauthPreset(id);
    return capability && capability.mode === "oauth_client"
      ? [one(id, capability, false)]
      : [];
  });
  return [...builtIn, ...presets];
}

export const PROVIDER_HANDLERS: Record<string, Handler> = {
  async provider_list(ctx) {
    const registry = await gatewayProviders();
    const admin = ctx.role === "owner" || ctx.role === "admin";
    const unbound = registry.unboundSettings();
    const rows = new Map(registry.rows().map((row) => [row.id, row]));
    // The OAuth side: the flow, the redirect URI, the client's source and
    // the connections, from the service the UI reads (never a value).
    const oauth = new Map(
      (await listOAuthProviders(ctx)).map((summary) => [summary.id, summary]),
    );
    // Which of the caller's own organization's apps list each provider;
    // never another organization's.
    const listing = new Map<string, string[]>();
    for (const app of await AppRepository.findAll(ctx.orgId)) {
      for (const id of capabilityIdsOf(manifestOf(app.manifest))) {
        listing.set(id, [...(listing.get(id) ?? []), app.appSlug]);
      }
    }
    const providers = registry
      .entries()
      .filter(([, capability]) => capability.mode !== "service")
      .map(([id, capability]) =>
        listed(id, capability, registry.sourceOf(id), rows.get(id), {
          admin,
          unbound,
          apps: listing.get(id) ?? [],
          ...(oauth.has(id) ? { oauth: oauth.get(id)! } : {}),
        }),
      );
    return {
      providers,
      registered: rows.size,
      presets: presetsListed(),
      next: "An app lists a provider's id under `capabilities` in its manifest; a setting that isn't set is set from the terminal with `everyapp secret set NAME` (never through a tool). An OAuth provider is added from a preset with everyapp_provider_add { preset }; people then connect in the browser at its connectPath.",
    };
  },

  async provider_add(ctx, args, principal) {
    const preset = typeof args["preset"] === "string" ? args["preset"] : null;
    const spec = args["spec"];
    if (preset !== null && spec !== undefined) {
      return refuse("INVALID_INPUT", "give one of spec or preset, not both");
    }
    if (preset !== null) {
      // A preset or a built-in client, through the service Admin → Providers
      // uses: the row (none for a built-in), the events, the same refusals.
      let summary: OAuthProviderSummary;
      try {
        summary = await addOAuthProvider(ctx, await userActor(ctx.userId), {
          preset,
        });
      } catch (error) {
        if (error instanceof PublicError) {
          return refuse(error.code, error.message);
        }
        throw error;
      }
      invalidateGatewayProviders();
      return {
        provider: {
          id: summary.id,
          name: summary.name,
          source: summary.source,
          kind: "oauth",
          flow: summary.flow,
          hosts: [],
          auth: { kind: "oauth2-user" },
          scopeSets: summary.scopeSets.map((set) => set.name),
          redirectUri: summary.redirectUri,
          console: summary.console,
          connectPath: `/connect/${summary.id}`,
        },
        settings: [...summary.settings],
        bound: summary.bound,
        next: summary.bound
          ? `Its client is set: people connect in the browser at /connect/${summary.id}. Register ${summary.redirectUri} at ${summary.console} if not done yet.`
          : `Register ${summary.redirectUri} at ${summary.console}, then set its client from the terminal: everyapp secret set ${summary.settings.join(" ")}, or paste it under Admin → Providers. People connect at /connect/${summary.id} once it is set.`,
      };
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      return refuse(
        "INVALID_INPUT",
        "spec must be the provider spec object (or give preset)",
      );
    }
    const text = JSON.stringify(spec);
    if (text.length > SPEC_MAX_BYTES) {
      return refuse("INVALID_INPUT", "spec is over 64 KiB");
    }
    const parsed = parseProviderSpec(spec);
    if (!parsed.ok) {
      return refuse(
        "PROVIDER_SPEC_INVALID",
        describeSpecProblems(parsed.problems),
      );
    }
    const { id, capability } = parsed;
    const read = await rowsOrOutdated();
    if ("error" in read) return read.error;
    if (read.rows.some((row) => row.id === id)) {
      return refuse(
        "PROVIDER_EXISTS",
        `${id} is registered on this Gateway already; this tool never replaces a row (from the terminal: everyapp provider add --replace, after which its key must be set again)`,
      );
    }
    const others = registryFromRows(read.rows);
    const refusal = checkProviderRow(id, capability, {
      rowSettings: new Set(
        others.rows().flatMap((row) => capabilitySettings(row.capability)),
      ),
      refuseHost: (host) => refusedGatewayHost(host, env),
    });
    if (refusal) return refuse(refusal.code, refusal.message);
    const settings = capabilitySettings(capability);
    for (const app of await AppRepository.findAllManifests()) {
      const manifest = manifestOf(app.manifest);
      if (!manifest) continue;
      const own = secretNames(
        manifest as Parameters<typeof secretNames>[0],
      ).map((name) => name.toUpperCase());
      const taken = settings.filter((name) => own.includes(name));
      if (taken.length > 0) {
        return refuse(
          "PROVIDER_SECRET_TAKEN",
          `${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} ${app.appSlug}'s own secret (its deployed manifest lists ${taken.length === 1 ? "it" : "them"} under secrets), so a provider can't read ${taken.length === 1 ? "it" : "them"} from the Gateway`,
        );
      }
    }
    const written = await ProviderRepository.insert({
      id,
      spec: text,
      addedBy: principal.email,
    });
    if (!written) {
      return refuse(
        "PROVIDER_EXISTS",
        `${id} was registered on this Gateway while this ran`,
      );
    }
    invalidateGatewayProviders();
    logEvent("provider.added", {
      provider: id,
      org: ctx.orgId,
      user_id: ctx.userId,
      via: "mcp",
    });
    // The organization's event (docs/design/2026-10-events-out.md), after
    // the write: a bus that fails is logged and never fails the add.
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.providerAdded({
        provider: { id, name: capability.label },
      }),
    }));
    return {
      provider: {
        id,
        name: capability.label,
        ...(capability.mode === "api_key"
          ? { hosts: [...capability.hosts], auth: authSummary(capability.auth) }
          : {
              hosts: [...capability.api],
              auth: { kind: "oauth2-user" },
              authorizeUrl: capability.authorize.url,
              scopeSets: Object.keys(capability.scopePolicy?.sets ?? {}),
              redirectUri: `${String((env as { GATEWAY_URL?: string }).GATEWAY_URL ?? "").replace(/\/+$/, "")}/connect/${id}/callback`,
              console: capability.console,
              connectPath: `/connect/${id}`,
            }),
      },
      settings: [...settings],
      bound: false,
      next:
        capability.mode === "api_key"
          ? `Set ${settings.length === 1 ? "its key" : "its settings"} from the terminal: everyapp secret set ${settings.join(" ")}. The Gateway sends nothing to ${capability.label} until then.`
          : `Set its client from the terminal: everyapp secret set ${settings.join(" ")}, or paste it under Admin → Providers. People connect at /connect/${id} once the client is set.`,
    };
  },

  async provider_remove(ctx, args) {
    const id = typeof args["id"] === "string" ? args["id"] : "";
    if (isBuiltinId(id)) {
      return refuse(
        "PROVIDER_BUILTIN",
        `${id} is built in; only a provider registered on this Gateway can be removed`,
      );
    }
    const read = await rowsOrOutdated();
    if ("error" in read) return read.error;
    const row = read.rows.find((each) => each.id === id);
    if (!row) {
      return refuse(
        "PROVIDER_NOT_FOUND",
        `no provider ${id} is registered on this Gateway`,
      );
    }
    const registered = registryFromRows(read.rows)
      .rows()
      .find((each) => each.id === id);
    const settings = registered
      ? capabilitySettings(registered.capability)
      : [];
    if (row.boundTo) {
      return refuse(
        "PROVIDER_BOUND",
        `${id}'s key is set on this Gateway; its operator removes it from the terminal: everyapp provider remove ${id}, then everyapp secret unset ${settings.join(" ") || "<its settings>"}`,
      );
    }
    const apps = (await AppRepository.findAllManifests())
      .filter((app) => capabilityIdsOf(manifestOf(app.manifest)).includes(id))
      .map((app) => app.appSlug);
    if (apps.length > 0) {
      return refuse(
        "PROVIDER_IN_USE",
        `${apps.join(", ")} ${apps.length === 1 ? "lists" : "list"} ${id} under capabilities; removing it would stop ${apps.length === 1 ? "its" : "their"} calls at once (from the terminal: everyapp provider remove ${id} --force)`,
      );
    }
    const removed = await ProviderRepository.removeUnbound(id);
    if (!removed) {
      return refuse(
        "PROVIDER_BOUND",
        `${id} changed on this Gateway while this ran; list the providers again`,
      );
    }
    invalidateGatewayProviders();
    logEvent("provider.removed", {
      provider: id,
      org: ctx.orgId,
      user_id: ctx.userId,
      via: "mcp",
    });
    const name = registered?.capability.label ?? id;
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.providerRemoved({ provider: { id, name } }),
    }));
    return {
      provider: { id, name },
      removed: true,
      settings: [...settings],
      ...(settings.length
        ? {
            next: `The Gateway settings it named stay until its operator runs: everyapp secret unset ${settings.join(" ")}. No provider reads them again without a new everyapp secret set.`,
          }
        : {}),
    };
  },
};
