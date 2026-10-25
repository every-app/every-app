/**
 * The built-in provider catalog as the docs show it, generated from the
 * catalog itself (`CAPABILITIES` in packages/sdk/src/internal/capabilities.ts),
 * so a provider added there reaches every page with `docs:update` and the
 * tests beside this file fail CI until it has:
 *
 *  - the catalog table of the agent page providers.md ({@link providersCatalog});
 *  - the AI and API-key settings tables of secrets.md ({@link catalogSettings});
 *  - the whole of the everyapp skill's setup/providers.md ({@link setupProvidersPage}).
 *
 * Each block on a page sits between `<!-- <name>:begin … -->` and
 * `<!-- <name>:end -->` markers, inside a prettier-ignore range so the
 * landing page's formatter leaves the generated tables as they are.
 *
 *   pnpm -C packages/cli docs:update
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
  isSettableGatewaySetting,
  oauthClientSecretSetCommand,
  tokenPathText,
  writeMethodsOf,
  type AiProviderCapability,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type Capability,
  type OAuthClientCapability,
  type ProviderDetails,
  type SmokeRequest,
} from "@every-app/sdk/internal";

type Entry<C> = readonly [string, C];

const catalog: ReadonlyArray<Entry<Capability>> = CAPABILITY_IDS.map((id) => [id, CAPABILITIES[id] as Capability] as const);

function ofMode<C extends Capability>(mode: C["mode"]): Array<Entry<C>> {
  return catalog.filter((entry): entry is Entry<C> => entry[1].mode === mode);
}

const apiKeys = ofMode<ApiKeyCapability>("api_key");
const aiProviders = ofMode<AiProviderCapability>("ai");
const oauthClients = ofMode<OAuthClientCapability>("oauth_client");
const services = catalog.filter(([, capability]) => capability.mode === "service").map(([id]) => id);

const code = (text: string) => `\`${text}\``;
/** A table cell's text: no pipe or line break may end the cell early. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
const list = (items: readonly string[]) => items.map(code).join(", ");

/** The request an `auth` block makes, the key named by its setting. */
function authRequest(auth: ApiKeyAuth): string {
  const key = `<${auth.secret}>`;
  switch (auth.kind) {
    case "bearer":
      return code(`Authorization: ${auth.scheme ?? "Bearer"} ${key}`);
    case "header":
      return code(`${auth.header}: ${auth.prefix ?? ""}${key}`);
    case "query":
      return `${code(`?${auth.param}=${key}`)} on the URL, in place of any the app sent`;
    case "basic": {
      if (auth.as === "pair") {
        return `${code(`Authorization: Basic ${key}`)}, the value \`login:password\` base64-encoded (or sent as it is when it holds no colon: already encoded)`;
      }
      if (auth.as === "username") return code(`Authorization: Basic base64(${key}:)`);
      const user = typeof auth.user === "string" ? auth.user : `<${auth.user.secret}>`;
      return code(`Authorization: Basic base64(${user}:${key})`);
    }
  }
}

/** Where an API-key provider's key may go, or an AI provider's base URL. */
function hostsOf(capability: ApiKeyCapability | AiProviderCapability): string {
  if (capability.mode === "ai") {
    return code(`${new URL(capability.origin).host}${capability.basePath ?? ""}`);
  }
  const named = capability.hostSetting ? [`the host ${code(`<${capability.hostSetting}>`)} names (a bare host or an https origin)`] : [];
  return [...capability.hosts.map(code), ...named].join(", ");
}

/** A provider's settings, a name `everyapp setup` writes marked as such. */
function settingsOf(capability: Capability): string {
  return capabilitySettings(capability)
    .map((name) => (isSettableGatewaySetting(name) ? code(name) : `${code(name)} (set by ${code("everyapp setup")})`))
    .join(", ");
}

/** The names `secret set` takes for a provider: its settings an operator sets. */
function settableOf(capability: Capability): string[] {
  return capabilitySettings(capability).filter((name) => isSettableGatewaySetting(name));
}

function smokeOf(capability: ApiKeyCapability | AiProviderCapability): string {
  const smoke: SmokeRequest | undefined = capability.mode === "api_key" ? capability.smoke : undefined;
  if (!smoke) return "none recorded";
  const host = smoke.host ?? (capability.mode === "api_key" ? (capability.hosts[0] ?? `<${capability.hostSetting}>`) : new URL(capability.origin).host);
  const free = smoke.free ? "free" : "charged";
  return `${code(`${smoke.method} https://${host}${smoke.path}`)}, expecting ${smoke.expect.join(" or ")}; ${free}${smoke.note ? `. ${smoke.note}` : ""}`;
}

function verifiedOf(details: ProviderDetails): string {
  if (details.verified === undefined) return "not recorded";
  if (details.verified === false) return "no: not checked against the provider's docs";
  return `${details.verified.on}, ${details.verified.how}`;
}

function costOf(details: ProviderDetails): string {
  const cost = details.cost;
  if (!cost) return "not recorded";
  const unit = { call: "per call", result: "per result", token: "per token" }[cost.unit];
  const usd = cost.usd === undefined ? "" : `, $${cost.usd}`;
  const field = cost.responseField ? ` The Gateway reads each answer's ${code(cost.responseField)} field (US dollars) into the usage counters.` : "";
  return `${unit}${usd}${cost.note ? `. ${cost.note}` : ""}${field}`;
}

function rateOf(details: ProviderDetails): string {
  const rate = details.rate;
  if (!rate) return "not recorded";
  const limits = [
    ...(rate.perSecond === undefined ? [] : [`${rate.perSecond} a second`]),
    ...(rate.perMinute === undefined ? [] : [`${rate.perMinute} a minute`]),
    ...(rate.perDay === undefined ? [] : [`${rate.perDay} a day`]),
  ];
  return [limits.join(", "), rate.note].filter(Boolean).join(". ");
}

/** The entry's hint, then each setting's own, as the settings model joins them. */
function hintOf(capability: ApiKeyCapability | AiProviderCapability): string {
  const names = capabilitySettings(capability);
  const details = (capability.secrets ?? []).filter((detail) => detail.hint && names.includes(detail.name));
  return [
    ...(capability.hint ? [capability.hint] : []),
    ...details.map((detail) => (names.length > 1 ? `${detail.name}: ${detail.hint}` : detail.hint!)),
  ].join(" ");
}

function keySource(capability: ApiKeyCapability | AiProviderCapability): string {
  return [capability.docs, ...(capability.api ? [`API reference ${capability.api}`] : [])].join("; ");
}

/** The guide file of an entry, relative to setup/: `dataforseo.md`. */
function guideOf(capability: Capability): string | undefined {
  return capability.setup?.replace(/^setup\//, "");
}

function marked(name: string, body: string[]): string {
  return [
    "<!-- prettier-ignore-start -->",
    `<!-- ${name}:begin (generated from packages/sdk/src/internal/capabilities.ts by packages/cli/src/docs/providersCatalog.ts; pnpm -C packages/cli docs:update) -->`,
    "",
    ...body,
    "",
    `<!-- ${name}:end -->`,
    "<!-- prettier-ignore-end -->",
  ].join("\n");
}

/** The counts a reader checks the table against. */
function counts(): string {
  return `${apiKeys.length + aiProviders.length + oauthClients.length} providers: ${apiKeys.length} API-key, ${aiProviders.length} AI, ${oauthClients.length} OAuth clients`;
}

/** providers.md's catalog block: every API-key and AI entry, then the OAuth clients and services by id. */
export function providersCatalog(): string {
  const rows = [...apiKeys, ...aiProviders].map(([id, capability]) =>
    row([
      code(id),
      capability.label,
      code(capability.mode),
      settingsOf(capability),
      hostsOf(capability),
      authRequest(capability.auth),
      keySource(capability),
      smokeOf(capability),
      verifiedOf(capability),
    ]),
  );
  return marked("providers-catalog", [
    `The built-in catalog has ${counts()}.`,
    "",
    "| Id | Name | Kind | Settings | Hosts | How the key is sent | Where the key comes from | Smoke request | Verified |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `OAuth clients (${code("oauth_client")}: the Gateway completes their token endpoints only, and the spec parser takes none as a row): ${list(oauthClients.map(([id]) => id))}. Their settings, consoles, redirect URIs, token endpoints and scope sets are generated in [the capabilities document](/docs/agent/repo/capabilities#oauth-clients). Gateway services (${code("service")}: no host, no spec): ${list(services)}.`,
  ]);
}

/** secrets.md's settings tables, one per kind: the AI providers' and the API-key providers'. */
export function catalogSettings(kind: "ai" | "api_key"): string {
  if (kind === "ai") {
    return marked("ai-provider-settings", [
      "| Setting | Configures | Manifest entry |",
      "| --- | --- | --- |",
      ...aiProviders.map(([id, capability]) =>
        row([
          settingsOf(capability),
          `${capability.label} (${hostsOf(capability)}), the key sent as ${authRequest(capability.auth)}. ${hintOf(capability)}`,
          code(`providers: ["${id}"]`),
        ]),
      ),
    ]);
  }
  return marked("api-key-provider-settings", [
    "| Setting | Configures | Manifest entry |",
    "| --- | --- | --- |",
    ...apiKeys.map(([id, capability]) =>
      row([
        settingsOf(capability),
        `${capability.label} (${hostsOf(capability)}), the key sent as ${authRequest(capability.auth)}. ${hintOf(capability)}`,
        code(`capabilities: { ${id} }`),
      ]),
    ),
  ]);
}

/** A URL on an OAuth client's instance when it has no fixed host (Mastodon's). */
function onInstance(capability: OAuthClientCapability, url: string): string {
  return url.startsWith("/") ? `<${capability.hostSetting}>${url}` : url;
}

function keySection(id: string, capability: ApiKeyCapability | AiProviderCapability): string[] {
  const guide = guideOf(capability);
  const settable = settableOf(capability);
  const what =
    capability.mode === "api_key"
      ? [
          `- **What apps may do:** access ${list(capability.access)}; ${capability.readMethods.join(", ")} on any grant${capability.access.includes("write") ? `, and ${writeMethodsOf(capability).join(", ")} for an entry with ${code('access: "write"')}` : ""}${capability.accountWidePaths.length > 0 ? `; account-wide paths refused: ${list(capability.accountWidePaths.map((run) => run.join("/")))}` : ""}${capability.data ? `; data ${code(capability.data)}${capability.data === "account" ? " (served on a self-hosted Gateway only)" : ""}` : ""}`,
        ]
      : [
          `- **What apps may do:** list it under ${code("providers")} and call ${code(`/api/ai/${id}/…`)} with ${code("createGatewayFetch()")}: POST to ${list(capability.inferenceRoutes)}${capability.extraRoutes ? `, and more only where both ${code("AI_PROXY_EXTRA_ROUTES")} and the app's ${code("ai.routes")} allow it` : ""}`,
        ];
  return [
    `### ${id}`,
    "",
    `**${capability.label}** (${code(capability.mode)})${capability.description ? `: ${capability.description}` : ""}`,
    "",
    `- **Settings:** ${settingsOf(capability)}`,
    ...(hintOf(capability) ? [`- **What the key is:** ${hintOf(capability)}`] : []),
    `- **Where the key comes from:** ${capability.docs}`,
    ...(capability.api ? [`- **API reference:** ${capability.api}`] : []),
    `- **How it is sent:** ${authRequest(capability.auth)}, to ${hostsOf(capability)} only, over https`,
    ...what,
    `- **Smoke request:** ${smokeOf(capability)}`,
    `- **Cost:** ${costOf(capability)}`,
    `- **Rate:** ${rateOf(capability)}`,
    `- **Verified:** ${verifiedOf(capability)}`,
    `- **Set it:** ${code(`pnpm everyapp secret set ${settable.join(" ")}`)}, or ${code("pnpm everyapp configure <app id>")} for everything an app needs`,
    `- **Guide:** ${guide ? `[${guide}](${guide})` : "none beyond this section"}`,
    "",
  ];
}

function oauthSection(id: string, capability: OAuthClientCapability): string[] {
  const guide = guideOf(capability);
  const sets = Object.keys(capability.scopePolicy?.sets ?? {});
  return [
    `### ${id}`,
    "",
    `**${capability.label}** (${code("oauth_client")}): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.`,
    "",
    `- **Settings:** ${settingsOf(capability)}`,
    `- **Where the client comes from:** ${capability.console.startsWith("/") ? code(onInstance(capability, capability.console)) : capability.console}`,
    `- **Redirect URIs to register:** ${list(capability.redirectPaths.map((path) => `https://<app>.<APP_BASE_DOMAIN>${path}`))}`,
    `- **How it is sent:** ${capability.token.map(({ host, path, methods, inject }) => `${methods.join("/")} ${code(`${host ?? `<${capability.hostSetting}>`}${tokenPathText(path)}`)} (the client in the ${inject === "basic" ? "Basic header" : inject === "form" ? "form body" : inject === "json" ? "JSON body" : "query"})`).join("; ")}`,
    `- **Scope sets an app lists:** ${sets.length > 0 ? list(sets) : "none: the whole client is the grant"}`,
    `- **Set it:** ${code(oauthClientSecretSetCommand(capability))}`,
    `- **Guide:** ${guide ? `[${guide}](${guide})` : "none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients"}`,
    "",
  ];
}

/** The first line of setup/providers.md: setupSkills.test.ts exempts a file that starts with it from the headings contract. */
export const GENERATED_SETUP_MARKER = "<!-- generated:";

/** The everyapp skill's setup/providers.md, whole. */
export function setupProvidersPage(): string {
  const kindName = { api_key: "API key", ai: "AI", oauth_client: "OAuth client" } as const;
  const index = [...apiKeys, ...aiProviders, ...oauthClients].map(([id, capability]) => {
    const guide = guideOf(capability);
    return row([`[${code(id)}](#${id})`, capability.label, kindName[capability.mode], settingsOf(capability), guide ? `[${guide}](${guide})` : ""]);
  });
  return [
    `${GENERATED_SETUP_MARKER} pnpm -C packages/cli docs:update writes this file from the built-in catalog (packages/sdk/src/internal/capabilities.ts, through packages/cli/src/docs/providersCatalog.ts). Edit the catalog, never this file: a test fails CI when it is stale. -->`,
    "",
    "# Every catalog provider: its settings, its key and one check",
    "",
    "For a coding agent setting up a provider the Gateway's built-in catalog has. Each provider is a section under its id, so `setup/providers.md#<id>` points at it. Where the provider has a file of its own in this folder (its **Guide**), follow that file and read this section as its summary. Read [README.md](README.md) first: its rules hold here too, above all that a key never goes through the chat.",
    "",
    `A provider registered on one Gateway (\`pnpm everyapp provider add\`) is not in this file: \`pnpm everyapp provider show <id>\` prints its whole spec (its hint, settings, hosts, where the key comes from and its smoke request). The catalog has ${counts()}.`,
    "",
    "The smoke request needs the key, so it runs where the key is: the person's terminal, with the variable they read in hidden, or through the app that uses it. It is one call that costs nothing (unless marked charged).",
    "",
    "## How a value gets in",
    "",
    "The three ways of [README.md](README.md), one line each (the rules, and the codes a failure carries, are there):",
    "",
    "- **The person types it**, in their own terminal in the `every-app` folder: `pnpm everyapp configure <app id>` (everything the app needs) or `pnpm everyapp secret set NAME` (one name), each value at a hidden prompt.",
    "- **A command produced it**: pipe it straight in, `… | pnpm everyapp secret set NAME --json`, so it is never shown.",
    "- **It is in an environment variable** the person read in hidden: `pnpm everyapp secret set NAME --from-env NAME --json`, or `pnpm everyapp configure <app id> --from-env --json`.",
    "",
    "## Providers",
    "",
    "| Id | Name | Kind | Settings | Guide |",
    "| --- | --- | --- | --- | --- |",
    ...index,
    "",
    `Gateway services have no key of this kind: ${list(services)} (sending mail is [email.md](email.md); the members list needs nothing).`,
    "",
    "## API-key providers",
    "",
    ...apiKeys.flatMap(([id, capability]) => keySection(id, capability)),
    "## AI providers",
    "",
    ...aiProviders.flatMap(([id, capability]) => keySection(id, capability)),
    "## OAuth clients",
    "",
    ...oauthClients.flatMap(([id, capability]) => oauthSection(id, capability)),
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * `page` with the block `name` replaced by `block` (the markers included),
 * or null when the page has no such block.
 */
export function withBlock(page: string, name: string, block: string): string | null {
  const start = page.indexOf(`<!-- prettier-ignore-start -->\n<!-- ${name}:begin`);
  const endMarker = `<!-- ${name}:end -->\n<!-- prettier-ignore-end -->`;
  const end = page.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return page.slice(0, start) + block + page.slice(end + endMarker.length);
}
