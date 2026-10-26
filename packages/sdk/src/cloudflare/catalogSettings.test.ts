/**
 * The generator of ./catalogSettings.generated.ts, and the drift test that
 * fails while the checked-in file differs from what the catalog
 * (`CAPABILITIES` in ../internal/capabilities.ts) generates. The file
 * exists because `everyAppWorker()` runs in cloudflare.config.ts and may
 * not import the catalog (see ./index.ts), and the Gateway's
 * cloudflare.config.ts may not either; so they read this leaf. A provider
 * added to or removed from the catalog reaches them with:
 *
 *   pnpm -C packages/sdk catalog:update
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { aiProviderSettings, DEV_AI_PROVIDERS } from "../internal/aiProviders";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
} from "../internal/capabilities";

const FILE = fileURLToPath(
  new URL("./catalogSettings.generated.ts", import.meta.url),
);
const UPDATE = Boolean(process.env["UPDATE_CATALOG"]);

const HEADER = `// Generated from packages/sdk/src/internal/capabilities.ts by
// src/cloudflare/catalogSettings.test.ts. Do not edit: change the catalog
// and run \`pnpm -C packages/sdk catalog:update\`.
`;

/** The module's text, before prettier. */
function source(): string {
  // Dev targets: every AI provider but the proxy (AI Gateway), whose
  // settings are the Gateway's alone since dev goes to providers directly.
  const providers = Object.fromEntries(
    Object.entries(DEV_AI_PROVIDERS).map(([id, spec]) => [
      id,
      aiProviderSettings(spec),
    ]),
  );
  // The AI providers are listed under `providers`, so never here.
  const capabilities = Object.fromEntries(
    CAPABILITY_IDS.flatMap((id) => {
      const capability = CAPABILITIES[id];
      return capability.mode === "ai"
        ? []
        : [[id, [...capabilitySettings(capability)]]];
    }),
  );
  const all = [
    ...new Set(
      CAPABILITY_IDS.flatMap((id) => capabilitySettings(CAPABILITIES[id])),
    ),
  ];
  return `${HEADER}
/**
 * The Gateway settings holding the keys of the AI providers and
 * capabilities an app may ask for, with the settings a provider needs
 * besides its key (Workers AI's account, a Basic username held as a
 * setting, a host setting), by manifest id. With no Gateway in
 * development, the SDK reaches them with the developer's own values under
 * the same names, and \`everyAppWorker()\` declares the ones set locally.
 */
export const DEV_GATEWAY_KEYS = ${JSON.stringify({ providers, capabilities })} as const;

/**
 * Every setting a catalog entry reads, in catalog order, each once: what
 * the Gateway's cloudflare.config.ts declares for local dev.
 */
export const CATALOG_GATEWAY_SETTINGS = ${JSON.stringify(all)} as const;
`;
}

async function generated(): Promise<string> {
  const options = (await resolveConfig(FILE)) ?? {};
  return format(source(), { ...options, filepath: FILE });
}

describe("catalogSettings.generated.ts", () => {
  it("is what the catalog generates", async () => {
    const expected = await generated();
    if (UPDATE) writeFileSync(FILE, expected);
    expect(
      readFileSync(FILE, "utf8"),
      "catalogSettings.generated.ts is out of date: run `pnpm -C packages/sdk catalog:update`.",
    ).toBe(expected);
  });
});
