/**
 * The CLI's side of the settings model: the evaluation against the names
 * each Worker holds, the one STATUS vocabulary, the table, and the words
 * a problem or warning says about an unmet setting.
 */
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  appSettings,
  CAPABILITIES,
  DEV_AI_PROVIDERS,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
} from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import {
  appSetupFrom,
  boundGatewayNames,
  declaresSettings,
  describeUnmet,
  describeUnmetSettings,
  gatewayMissing,
  gatewayNamesRead,
  gatewayNeeds,
  helperRows,
  namesToSet,
  renderSettingsTable,
  settingsRows,
  settingStatus,
} from "./settings";

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

/** What OpenRouter's entry says its key is (its `hint`). */
const OPENROUTER_HINT =
  "An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.";

/** CRM: an AI model from either provider, an optional capability, a required and an optional secret. */
const CRM = {
  providers: [
    { id: "openai", anyOf: "AI model" },
    { id: "openrouter", anyOf: "AI model", why: "Any model through one key." },
  ],
  capabilities: {
    context: { access: "read", optional: true, why: "Renders JavaScript pages." },
    members: { access: "read" },
  },
  secrets: [
    { name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." },
    { name: "GITHUB_TOKEN", optional: true },
  ],
};

describe("appSetupFrom", () => {
  it("evaluates each setting against the names its holder has, unknown when a list is missing", () => {
    const { report, setup } = appSetupFrom({
      manifest: CRM,
      appId: "crm",
      gatewayNames: ["OPENROUTER_API_KEY", "BETTER_AUTH_SECRET"],
      secretNames: null,
    });
    expect(report.settings.map((setting) => [setting.id, setting.set, setting.blocking])).toEqual([
      ["openai", false, false],
      ["openrouter", true, false],
      ["context", false, false],
      ["members", true, false],
      ["TOKEN_ENCRYPTION_KEY", null, false],
      ["GITHUB_TOKEN", null, false],
    ]);
    // Names never recorded don't block; the command runs as `pnpm everyapp`.
    expect(setup).toMatchObject({ ready: true, command: null });

    const unset = appSetupFrom({ manifest: CRM, appId: "crm", gatewayNames: [], secretNames: [] });
    expect(unset.setup.ready).toBe(false);
    expect(unset.setup.command).toEqual({ command: "pnpm everyapp configure crm" });
    expect(namesToSet(unset.setup)).toEqual(["TOKEN_ENCRYPTION_KEY", "OPENAI_API_KEY"]);

    // The Gateway's names unknown: nothing of the Gateway's blocks.
    const unlisted = appSetupFrom({ manifest: CRM, appId: "crm", gatewayNames: null, secretNames: [] });
    expect(unlisted.report.settings.find((setting) => setting.id === "openai")!.set).toBeNull();
    expect(unlisted.setup.unmet.map((setting) => setting.id)).toEqual(["TOKEN_ENCRYPTION_KEY"]);
  });

  it("knows whether a manifest declares anything to set", () => {
    expect(declaresSettings({})).toBe(false);
    expect(declaresSettings({ capabilities: { members: { access: "read" } } })).toBe(false);
    expect(declaresSettings({ secrets: ["MAIN_SECRET"] })).toBe(true);
    expect(declaresSettings({ providers: ["openai"] })).toBe(true);
  });

  it("names every Gateway setting a manifest reads, what a setting also reads included, once", () => {
    expect(gatewayNamesRead(CRM)).toEqual(["OPENAI_API_KEY", "OPENROUTER_API_KEY", "CONTEXT_API_KEY"]);
    expect(gatewayNamesRead({ providers: ["workers-ai"], capabilities: { email: { access: "write" } } })).toEqual([
      "WORKERS_AI_API_TOKEN",
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_REST_API_TOKEN",
      "RESEND_API_KEY",
      "EMAIL_PROVIDER",
    ]);
    expect(gatewayNamesRead({ secrets: ["MAIN_SECRET"] })).toEqual([]);
  });
});

describe("the Gateway names an app needs, as secret list --json has always said them", () => {
  it("marks required and any-of names required, what is read when set not, and lists only what keeps the app closed as missing", () => {
    const { report } = appSetupFrom({
      manifest: { ...CRM, capabilities: { ...CRM.capabilities, email: { access: "write" } } },
      appId: "crm",
      gatewayNames: ["OPENROUTER_API_KEY"],
      secretNames: [],
    });
    expect(gatewayNeeds(report.settings, ["OPENROUTER_API_KEY"])).toEqual([
      { name: "OPENAI_API_KEY", required: true, set: false },
      { name: "OPENROUTER_API_KEY", required: true, set: true },
      { name: "CONTEXT_API_KEY", required: false, set: false },
      { name: "EMAIL_FROM", required: true, set: false },
      { name: "EMAIL_FROM_NAME", required: true, set: false },
      { name: "EMAIL_REST_API_TOKEN", required: false, set: false },
      { name: "RESEND_API_KEY", required: false, set: false },
      { name: "EMAIL_PROVIDER", required: false, set: false },
    ]);
    // The AI model group is met: its other member isn't missing.
    expect(gatewayMissing(report.settings, ["OPENROUTER_API_KEY"])).toEqual(["EMAIL_FROM", "EMAIL_FROM_NAME"]);

    const none = appSetupFrom({ manifest: CRM, appId: "crm", gatewayNames: [], secretNames: [] });
    expect(gatewayMissing(none.report.settings, [])).toEqual(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  });

  it("says a name once when two settings read it, required where either does", () => {
    const { report } = appSetupFrom({
      manifest: { providers: ["openai"], ai: { routes: ["/v1/files"] } },
      appId: "files",
      gatewayNames: [],
      secretNames: [],
    });
    expect(gatewayNeeds(report.settings, []).map((need) => need.name)).toEqual([
      "OPENAI_API_KEY",
      "AI_PROXY_EXTRA_ROUTES",
    ]);
  });
});

describe("the STATUS vocabulary", () => {
  const status = (setting: Parameters<typeof settingStatus>[0]) => stripVTControlCharacters(settingStatus(setting));
  const required = { kind: "required" } as const;
  const anyOf = { kind: "anyOf", group: "AI model" } as const;

  it("says set, not set (required or an unmet group), optional, one of a met group, not recorded, or couldn't check", () => {
    expect(status({ set: true, need: required, blocking: false, holder: "gateway" })).toBe("✓ set");
    expect(status({ set: false, need: required, blocking: true, holder: "gateway" })).toBe("! not set");
    expect(status({ set: false, need: anyOf, blocking: true, holder: "gateway" })).toBe("! not set");
    expect(status({ set: false, need: { kind: "optional" }, blocking: false, holder: "app" })).toBe(
      "not set (optional)",
    );
    expect(status({ set: false, need: anyOf, blocking: false, holder: "gateway" })).toBe(
      "not set (one of: AI model)",
    );
    expect(status({ set: null, need: required, blocking: false, holder: "app" })).toBe("! not recorded");
    expect(status({ set: null, need: required, blocking: false, holder: "gateway" })).toBe("! couldn't check");
  });

  it("renders one row per setting with something to set, the names joined with +, with or without the APP column", () => {
    const { report } = appSetupFrom({
      manifest: {
        capabilities: { mastodon: { access: "write" }, members: { access: "read" } },
        secrets: ["MAIN_SECRET"],
      },
      appId: "social",
      gatewayNames: ["MASTODON_CLIENT_ID"],
      secretNames: ["MAIN_SECRET"],
    });
    const rows = settingsRows("social", report.settings);
    const client = "MASTODON_CLIENT_ID+MASTODON_CLIENT_SECRET";
    const pad = (cell: string) => cell.padEnd(client.length);
    expect(plain(renderSettingsTable(rows))).toEqual([
      `APP     ${pad("SETTING")}  WHERE    STATUS`,
      `social  ${client}  Gateway  ! not set`,
      `social  ${pad("MAIN_SECRET")}  social   ✓ set`,
    ]);
    expect(plain(renderSettingsTable(rows, { app: false }))).toEqual([
      `${pad("SETTING")}  WHERE    STATUS`,
      `${client}  Gateway  ! not set`,
      `${pad("MAIN_SECRET")}  social   ✓ set`,
    ]);
  });
});

describe("helperRows", () => {
  it("gives a helper Worker the app's own rows against what it holds, in the same words", () => {
    const manifest = {
      providers: [{ id: "openai", anyOf: "AI key" }],
      secrets: ["MAIN_SECRET", { name: "GITHUB_TOKEN", optional: true }, { name: "MODEL_KEY", anyOf: "AI key" }],
    };
    const rows = (settings: Parameters<typeof helperRows>[2]) =>
      helperRows("seo", "audit", settings).map((row) => [row.setting, row.where, stripVTControlCharacters(row.status)]);

    // The helper holds nothing of its own; the Gateway's OpenAI key meets the group for it.
    const { report } = appSetupFrom({ manifest, appId: "seo", gatewayNames: ["OPENAI_API_KEY"], secretNames: [] });
    expect(rows(report.settings)).toEqual([
      ["MAIN_SECRET", "audit helper", "! not set"],
      ["GITHUB_TOKEN", "audit helper", "not set (optional)"],
      ["MODEL_KEY", "audit helper", "not set (one of: AI key)"],
    ]);

    // No key anywhere: the group is unmet for it.
    const bare = appSetupFrom({ manifest, appId: "seo", gatewayNames: [], secretNames: ["MAIN_SECRET"] });
    expect(rows(bare.report.settings)).toEqual([
      ["MAIN_SECRET", "audit helper", "✓ set"],
      ["GITHUB_TOKEN", "audit helper", "not set (optional)"],
      ["MODEL_KEY", "audit helper", "! not set"],
    ]);
  });
});

describe("describeUnmet", () => {
  it("says the label with its why, or its names when the label doesn't name them, then what the key is, then where to get it", () => {
    const { setup } = appSetupFrom({
      manifest: {
        providers: ["openrouter"],
        capabilities: { dataforseo: { access: "read", why: "Keyword data." } },
        secrets: ["MAIN_SECRET", { name: "SIGNING_KEY", why: "Signs the tracker's cookies.", docs: "https://example.com/keys" }],
      },
      appId: "analytics",
      gatewayNames: [],
      secretNames: [],
    });
    expect(setup.unmet.map(describeUnmet)).toEqual([
      [
        "OpenRouter: OPENROUTER_API_KEY",
        OPENROUTER_HINT,
        "Get it at https://openrouter.ai/settings/keys",
      ],
      [
        "DataForSEO: Keyword data.",
        // The entry's hint, then its one setting's own.
        "The API login and password from API Access, as login:password (or that pair base64-encoded); the Gateway sends them as HTTP Basic. login:password, or its base64; never the dashboard sign-in password.",
        "Get it at https://app.dataforseo.com/api-access",
      ],
      ["MAIN_SECRET"],
      ["SIGNING_KEY: Signs the tracker's cookies.", "Get it at https://example.com/keys"],
    ]);
  });

  it("adds each setting's setup guide once: the registry's for the Gateway's, the entry's for the app's own", () => {
    const { setup } = appSetupFrom({
      manifest: {
        providers: ["openrouter"],
        // Two Google clients share one guide.
        capabilities: { "google-workspace": { access: "write" }, youtube: { access: "write" } },
        secrets: ["MAIN_SECRET", { name: "SIGNING_KEY", setup: "setup/signing-key.md" }],
      },
      appId: "analytics",
      gatewayNames: [],
      secretNames: [],
    });
    expect(describeUnmetSettings(setup.unmet)).toEqual([
      "OpenRouter: OPENROUTER_API_KEY",
      OPENROUTER_HINT,
      "Get it at https://openrouter.ai/settings/keys",
      "Guide: .claude/skills/everyapp/setup/openrouter.md",
      "Google (Gmail, Calendar, Search Console and Analytics): GOOGLE_WORKSPACE_CLIENT_ID and GOOGLE_WORKSPACE_CLIENT_SECRET",
      "Get it at https://console.cloud.google.com/apis/credentials",
      "Guide: .claude/skills/everyapp/setup/google.md",
      "YouTube: YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET",
      "Get it at https://console.cloud.google.com/apis/credentials",
      "MAIN_SECRET",
      "SIGNING_KEY",
      "Guide: .claude/skills/everyapp/setup/signing-key.md",
    ]);
  });

  it("points at provider show for a provider without a guide: a registered one, or a client the skill has no file for", () => {
    const { setup } = appSetupFrom({
      manifest: {
        capabilities: {
          stripe: { access: "read", why: "Shows the last charges." },
          linkedin: { access: "write" },
          dataforseo: { access: "read" },
        },
      },
      appId: "shop",
      gatewayNames: [],
      secretNames: [],
      lookup: STRIPE_REGISTRY,
    });
    expect(describeUnmetSettings(setup.unmet)).toEqual([
      "Stripe: Shows the last charges.",
      "A restricted key from the Stripe dashboard. Read access to Charges is enough.",
      "Get it at https://dashboard.stripe.com/apikeys",
      "Guide: pnpm everyapp provider show stripe",
      "LinkedIn: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET",
      "Get it at https://www.linkedin.com/developers/apps",
      "Guide: pnpm everyapp provider show linkedin",
      "DataForSEO: DATAFORSEO_API_KEY",
      expect.stringMatching(/^The API login and password/),
      "Get it at https://app.dataforseo.com/api-access",
      "Guide: .claude/skills/everyapp/setup/dataforseo.md",
    ]);
  });
});

/** A gateway's registry with one registered provider, Stripe, with the Gateway's host rule. */
const STRIPE_SPEC = {
  id: "stripe",
  name: "Stripe",
  docs: "https://dashboard.stripe.com/apikeys",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
  hint: "A restricted key from the Stripe dashboard.",
  secrets: [{ name: "STRIPE_API_KEY", hint: "Read access to Charges is enough." }],
};
const STRIPE_REGISTRY = providerRegistry([{ id: "stripe", spec: STRIPE_SPEC }]);

describe("a gateway's registered providers", () => {
  const manifest = { capabilities: { stripe: { access: "read" } }, secrets: ["MAIN_SECRET"] };

  it("are settings like a catalog provider's once the registry is the lookup, and nothing without it", () => {
    expect(declaresSettings({ capabilities: { stripe: { access: "read" } } })).toBe(false);
    expect(declaresSettings({ capabilities: { stripe: { access: "read" } } }, STRIPE_REGISTRY)).toBe(true);
    expect(gatewayNamesRead(manifest, STRIPE_REGISTRY)).toEqual(["STRIPE_API_KEY"]);
    const { setup } = appSetupFrom({
      manifest,
      appId: "shop",
      gatewayNames: [],
      secretNames: ["MAIN_SECRET"],
      lookup: STRIPE_REGISTRY,
    });
    expect(setup.unmet.map((setting) => setting.names)).toEqual([["STRIPE_API_KEY"]]);
  });

  it("read a key that isn't bound to the row's hosts as not set, as the Gateway reads it", () => {
    const set = { manifest, appId: "shop", gatewayNames: ["STRIPE_API_KEY"], secretNames: ["MAIN_SECRET"] };
    // Never bound (just added, or replaced since): the Gateway doesn't read it.
    expect(appSetupFrom({ ...set, lookup: STRIPE_REGISTRY }).setup.ready).toBe(false);
    expect(boundGatewayNames(["STRIPE_API_KEY", "OPENAI_API_KEY"], STRIPE_REGISTRY)).toEqual(["OPENAI_API_KEY"]);
    const parsed = parseProviderSpec(STRIPE_SPEC);
    if (!parsed.ok) throw new Error("the spec parses");
    const bound = providerRegistry([
      { id: "stripe", spec: STRIPE_SPEC, boundTo: providerBindingKey(parsed.capability) },
    ]);
    expect(appSetupFrom({ ...set, lookup: bound }).setup.ready).toBe(true);
    // The catalog alone has nothing to leave out.
    expect(boundGatewayNames(["STRIPE_API_KEY"])).toEqual(["STRIPE_API_KEY"]);
  });
});

describe("the setup guides the registries name", () => {
  it("exist in the everyapp skill, one file per guide", () => {
    const skill = path.resolve(__dirname, "../../../skills/everyapp");
    const everything = {
      providers: Object.keys(DEV_AI_PROVIDERS),
      // Every capability; the AI providers are listed under `providers`.
      capabilities: Object.fromEntries(
        Object.entries(CAPABILITIES).flatMap(([id, capability]) =>
          capability.mode === "ai" ? [] : [[id, { access: capability.access[0] }]],
        ),
      ),
      ai: { routes: ["/v1/files"] },
    };
    const guides = [...new Set(appSettings(everything).flatMap((setting) => (setting.setup ? [setting.setup] : [])))];
    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      expect(fs.existsSync(path.join(skill, guide)), guide).toBe(true);
    }
  });
});
