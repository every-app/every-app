/**
 * docs/capabilities.md's "API-key providers" and "OAuth clients" tables are
 * generated from the catalog and the OAuth presets, so the operator's
 * checklist can't drift from what the gateway enforces. When this fails,
 * regenerate them:
 *
 *   UPDATE_DOCS=1 pnpm -C packages/sdk exec vitest run src/internal/capabilitiesDoc.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilitySettings,
  oauthClientSecretSetCommand,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type OAuthClientCapability,
} from "./capabilities";
import { oauthPreset, oauthPresetIds } from "./oauthPresets";
import { writeMethodsOf } from "./providerSpec";

const DOC = new URL("../../../../docs/capabilities.md", import.meta.url);
const BEGIN =
  "<!-- oauth-clients:begin (generated from packages/sdk/src/internal/oauthPresets.ts by capabilitiesDoc.test.ts) -->";
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

const clients = oauthPresetIds().map(
  (id) => [id, oauthPreset(id) as OAuthClientCapability] as const,
);

function generated(): string {
  const rows = clients.map(([id, capability]) =>
    [
      `\`${id}\``,
      capability.label,
      capabilitySettings(capability)
        .map((name) => `\`${name}\``)
        .join(", "),
      capability.console,
      capability.api.map((host) => `\`${host}\``).join(", "),
    ].join(" | "),
  );
  const commands = clients.map(([, capability]) =>
    oauthClientSecretSetCommand(capability),
  );
  const scopes = clients.map(([id, { flow }]) =>
    [
      `\`${id}\``,
      flow.scopeSeparator,
      flow.scopePrefix ? `\`${flow.scopePrefix}\`` : "none",
      flow.identityScopes.length > 0
        ? flow.identityScopes.map((scope) => `\`${scope}\``).join(", ")
        : "none",
    ].join(" | "),
  );
  return [
    BEGIN,
    "",
    "| Preset | Provider | Gateway secrets | Developer console | API hosts the token is sent to |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
    "",
    "The commands, one per client you offer, once its provider is registered (each prompts for the values):",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "How each provider spells scopes. An app lists the provider's own scopes (`scopes` on its capability entry), short (joined onto the prefix) or in full; the Gateway adds the identity scopes to every connect:",
    "",
    "| Preset | Separator | Scope prefix | Identity scopes |",
    "| --- | --- | --- | --- |",
    ...scopes.map((row) => `| ${row} |`),
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

  it("lists every OAuth provider as the catalog defines it", () => {
    expectGenerated(BEGIN, END, generated());
  });
});
