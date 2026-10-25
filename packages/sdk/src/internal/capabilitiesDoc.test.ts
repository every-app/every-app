/**
 * docs/capabilities.md's "API-key providers" and "OAuth clients" tables are
 * generated from the catalog, so the operator's checklist can't drift from
 * what the gateway enforces. When this fails, regenerate them:
 *
 *   UPDATE_DOCS=1 pnpm -C packages/sdk exec vitest run src/internal/capabilitiesDoc.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilitySettings,
  oauthClientSecretSetCommand,
  tokenPathText,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type OAuthClientCapability,
  type OAuthTokenEndpoint,
} from "./capabilities";
import { writeMethodsOf } from "./providerSpec";

const DOC = new URL("../../../../docs/capabilities.md", import.meta.url);
const BEGIN =
  "<!-- oauth-clients:begin (generated from packages/sdk/src/internal/capabilities.ts by capabilitiesDoc.test.ts) -->";
const END = "<!-- oauth-clients:end -->";
const API_KEY_BEGIN =
  "<!-- api-key-providers:begin (generated from packages/sdk/src/internal/capabilities.ts by capabilitiesDoc.test.ts) -->";
const API_KEY_END = "<!-- api-key-providers:end -->";

const code = (text: string) => `\`${text}\``;

const apiKeyProviders = Object.entries(CAPABILITIES).flatMap(
  ([id, capability]) =>
    capability.mode === "api_key"
      ? [[id, capability as ApiKeyCapability] as const]
      : [],
);

/**
 * The request an `auth` block makes, the key named by its setting (the
 * agent docs' generator, packages/cli/src/docs/providersCatalog.ts, says
 * the same in its own words).
 */
function authRequest(auth: ApiKeyAuth): string {
  const key = `<${auth.secret}>`;
  switch (auth.kind) {
    case "bearer":
      return code(`Authorization: ${auth.scheme ?? "Bearer"} ${key}`);
    case "header":
      return code(`${auth.header}: ${auth.prefix ?? ""}${key}`);
    case "query":
      return `${code(`?${auth.param}=${key}`)} on the URL, in place of the app's own`;
    case "basic": {
      if (auth.as === "pair") {
        return `${code(`Authorization: Basic ${key}`)} (${code("login:password")}, base64-encoded unless it already is)`;
      }
      if (auth.as === "username") {
        return code(`Authorization: Basic base64(${key}:)`);
      }
      const user =
        typeof auth.user === "string" ? auth.user : `<${auth.user.secret}>`;
      return code(`Authorization: Basic base64(${user}:${key})`);
    }
  }
}

function apiKeyRow(id: string, capability: ApiKeyCapability): string {
  const offersWrite = capability.access.includes("write");
  return [
    code(id),
    capability.label,
    capabilitySettings(capability).map(code).join(", "),
    [
      ...capability.hosts.map(code),
      ...(capability.hostSetting
        ? [`the host ${code(`<${capability.hostSetting}>`)} names`]
        : []),
    ].join(", "),
    authRequest(capability.auth),
    capability.access.map(code).join(", "),
    `${capability.readMethods.join(", ")}${offersWrite ? `; with ${code('access: "write"')} also ${writeMethodsOf(capability).join(", ")}` : ""}`,
  ].join(" | ");
}

function generatedApiKeyProviders(): string {
  return [
    API_KEY_BEGIN,
    "",
    "| Capability | Provider | Gateway settings | Hosts the key may reach | How the key is sent | Access | Methods |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...apiKeyProviders.map(
      ([id, capability]) => `| ${apiKeyRow(id, capability)} |`,
    ),
    "",
    API_KEY_END,
  ].join("\n");
}

const clients = Object.entries(CAPABILITIES).flatMap(([id, capability]) =>
  capability.mode === "oauth_client"
    ? [[id, capability as OAuthClientCapability] as const]
    : [],
);

/** A URL on the client's instance when it has no fixed host (Mastodon's). */
function onInstance(capability: OAuthClientCapability, url: string): string {
  return url.startsWith("/") ? `<${capability.hostSetting}>${url}` : url;
}

/** A console URL: a link, or code when it names the instance setting. */
function consoleCell(capability: OAuthClientCapability): string {
  const url = onInstance(capability, capability.console);
  return url.startsWith("<") ? `\`${url}\`` : url;
}

function endpoint(
  capability: OAuthClientCapability,
  { host, path, methods, inject, params }: OAuthTokenEndpoint,
): string {
  const renamed = params?.clientId ? `, id as \`${params.clientId}\`` : "";
  return `${methods.join("/")} \`${host ?? `<${capability.hostSetting}>`}${tokenPathText(path)}\` (${inject}${renamed})`;
}

function generated(): string {
  const rows = clients.map(([id, capability]) =>
    [
      `\`${id}\``,
      capability.label,
      capabilitySettings(capability)
        .map((name) => `\`${name}\``)
        .join(", "),
      consoleCell(capability),
      capability.redirectPaths
        .map((path) => `\`https://<app>.<APP_BASE_DOMAIN>${path}\``)
        .join(", "),
      capability.token.map((rule) => endpoint(capability, rule)).join("; "),
    ].join(" | "),
  );
  const commands = clients.map(([, capability]) =>
    oauthClientSecretSetCommand(capability),
  );
  const scopes = clients.map(([id, capability]) =>
    [
      `\`${id}\``,
      `\`${onInstance(capability, capability.authorize.url)}\``,
      capability.authorize.scopes.map((scope) => `\`${scope}\``).join(", "),
    ].join(" | "),
  );
  const sets = clients.flatMap(([id, capability]) =>
    Object.entries(capability.scopePolicy?.sets ?? {}).map(([name, set]) =>
      [
        `\`${id}\``,
        `\`${name}\``,
        set.label,
        set.access,
        [
          ...set.scopes.map((scope) => `\`${scope}\``),
          ...(set.userScopes ?? []).map((scope) => `\`${scope}\` (user token)`),
        ].join(", "),
      ].join(" | "),
    ),
  );
  return [
    BEGIN,
    "",
    "| Capability | Network | Gateway secrets | Developer console | Redirect URIs to register | Token endpoints the gateway completes (where the client goes) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
    "",
    "The commands, one per network you offer (each prompts for the values):",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "The authorize page each client sends people to, and the scopes the operator allows on the client; an app lists the scope sets it uses:",
    "",
    "| Capability | Authorize URL | Scopes |",
    "| --- | --- | --- |",
    ...scopes.map((row) => `| ${row} |`),
    "",
    "Scope sets an app may list (`scopes` on its capability entry), each with the provider scopes it asks for; a client with none takes the whole client as the grant:",
    "",
    "| Capability | Scope set | Label | Access | Provider scopes |",
    "| --- | --- | --- | --- | --- |",
    ...sets.map((row) => `| ${row} |`),
    "",
    END,
  ].join("\n");
}

/** The block between `begin` and `end` against `block`, or rewritten with UPDATE_DOCS. */
function expectGenerated(begin: string, end: string, block: string): void {
  const doc = readFileSync(DOC, "utf8");
  const start = doc.indexOf(begin);
  const stop = doc.indexOf(end);
  expect(start, "the generated section's begin marker").toBeGreaterThan(-1);
  expect(stop, "its end marker").toBeGreaterThan(start);
  const current = doc.slice(start, stop + end.length);
  if (process.env["UPDATE_DOCS"] && current !== block) {
    writeFileSync(DOC, doc.replace(current, block));
    return;
  }
  expect(current).toBe(block);
}

describe("docs/capabilities.md", () => {
  it("lists every API-key provider as the catalog defines it", () => {
    expectGenerated(API_KEY_BEGIN, API_KEY_END, generatedApiKeyProviders());
  });

  it("lists every OAuth client as the registry defines it", () => {
    expectGenerated(BEGIN, END, generated());
  });
});
