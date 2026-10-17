/**
 * docs/capabilities.md's "OAuth clients" tables are generated from the
 * registry, so the operator's checklist can't drift from what the gateway
 * enforces. When this fails, regenerate them:
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
  type OAuthClientCapability,
  type OAuthTokenEndpoint,
} from "./capabilities";

const DOC = new URL("../../../../docs/capabilities.md", import.meta.url);
const BEGIN =
  "<!-- oauth-clients:begin (generated from packages/sdk/src/internal/capabilities.ts by capabilitiesDoc.test.ts) -->";
const END = "<!-- oauth-clients:end -->";

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
    "The authorize page each client sends people to, and the scopes the app asks for there (the client must be allowed them):",
    "",
    "| Capability | Authorize URL | Scopes |",
    "| --- | --- | --- |",
    ...scopes.map((row) => `| ${row} |`),
    "",
    END,
  ].join("\n");
}

describe("docs/capabilities.md", () => {
  it("lists every OAuth client as the registry defines it", () => {
    const doc = readFileSync(DOC, "utf8");
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    expect(start, "the generated section's begin marker").toBeGreaterThan(-1);
    expect(end, "its end marker").toBeGreaterThan(start);
    const current = doc.slice(start, end + END.length);
    if (process.env["UPDATE_DOCS"] && current !== generated()) {
      writeFileSync(DOC, doc.replace(current, generated()));
      return;
    }
    expect(current).toBe(generated());
  });
});
