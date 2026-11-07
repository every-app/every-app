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
  CATALOG,
  DEV_AI_PROVIDERS,
  oauthPresetIds,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
  withOAuthPresets,
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
  featuresLine,
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

/** CRM: a required AI provider and secret; an optional pin, capability and secret, each in a feature. */
const CRM = {
  providers: ["openai", { id: "openrouter", why: "Any model through one key." }],
  capabilities: {
    context: { access: "read", why: "Renders JavaScript pages." },
    members: { access: "read" },
  },
  secrets: [{ name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." }],
  features: {
    pin: { name: "OpenAI pin", why: "A pinned model.", providers: ["openai"] },
    rendering: { name: "Rendering", why: "JS sites.", capabilities: ["context"] },
    github: { name: "GitHub", why: "Rate limit.", secrets: ["GITHUB_TOKEN"] },
  },
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
    expect(namesToSet(unset.setup)).toEqual(["OPENROUTER_API_KEY", "TOKEN_ENCRYPTION_KEY"]);
    expect(unset.setup.features.map((feature) => [feature.id, feature.state])).toEqual([
      ["pin", "off"],
      ["rendering", "off"],
      ["github", "off"],
    ]);

    // The Gateway's names unknown: nothing of the Gateway's blocks.
    const unlisted = appSetupFrom({ manifest: CRM, appId: "crm", gatewayNames: null, secretNames: [] });
    expect(unlisted.report.settings.find((setting) => setting.id === "openrouter")!.set).toBeNull();
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
  it("marks required names required, an optional feature's and what is read when set not, and lists only what keeps the app closed as missing", () => {
    const { report } = appSetupFrom({
      manifest: { ...CRM, capabilities: { ...CRM.capabilities, email: { access: "write" } } },
      appId: "crm",
      gatewayNames: ["OPENROUTER_API_KEY"],
      secretNames: [],
    });
    expect(gatewayNeeds(report.settings, ["OPENROUTER_API_KEY"])).toEqual([
      { name: "OPENAI_API_KEY", required: false, set: false },
      { name: "OPENROUTER_API_KEY", required: true, set: true },
      { name: "CONTEXT_API_KEY", required: false, set: false },
      { name: "EMAIL_FROM", required: true, set: false },
      { name: "EMAIL_FROM_NAME", required: true, set: false },
      { name: "EMAIL_REST_API_TOKEN", required: false, set: false },
      { name: "RESEND_API_KEY", required: false, set: false },
      { name: "EMAIL_PROVIDER", required: false, set: false },
    ]);
    // The optional pin isn't missing.
    expect(gatewayMissing(report.settings, ["OPENROUTER_API_KEY"])).toEqual(["EMAIL_FROM", "EMAIL_FROM_NAME"]);

    const none = appSetupFrom({ manifest: CRM, appId: "crm", gatewayNames: [], secretNames: [] });
    expect(gatewayMissing(none.report.settings, [])).toEqual(["OPENROUTER_API_KEY"]);
  });
});

describe("the STATUS vocabulary", () => {
  const status = (setting: Parameters<typeof settingStatus>[0]) => stripVTControlCharacters(settingStatus(setting));
  const required = { kind: "required" } as const;

  it("says set, not set (required), optional, not recorded, or couldn't check", () => {
    expect(status({ set: true, need: required, holder: "gateway" })).toBe("✓ set");
    expect(status({ set: false, need: required, holder: "gateway" })).toBe("! not set");
    expect(status({ set: false, need: { kind: "optional" }, holder: "app" })).toBe("not set (optional)");
    expect(status({ set: null, need: required, holder: "app" })).toBe("! not recorded");
    expect(status({ set: null, need: required, holder: "gateway" })).toBe("! couldn't check");
  });

  it("says each app's features in one line", () => {
    expect(
      stripVTControlCharacters(
        featuresLine([
          { name: "GitHub", state: "ready" },
          { name: "Slack", state: "off" },
          { name: "Sandboxes", state: "incomplete" },
        ])!,
      ),
    ).toBe("GitHub ✓ · Slack off · Sandboxes incomplete");
    expect(featuresLine([])).toBeNull();
  });

  it("renders one row per setting with something to set, the names joined with +, with or without the APP column", () => {
    const { report } = appSetupFrom({
      manifest: {
        capabilities: { slack: { scopes: ["chat:write"], why: "Posts updates." }, members: { access: "read" } },
        secrets: ["MAIN_SECRET"],
      },
      appId: "social",
      gatewayNames: ["SLACK_CLIENT_ID"],
      secretNames: ["MAIN_SECRET"],
      lookup: withOAuthPresets(CATALOG),
    });
    const rows = settingsRows("social", report.settings);
    const client = "SLACK_CLIENT_ID+SLACK_CLIENT_SECRET";
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

describe("the Gateway's default model and its pins (launch gate, rc.7)", () => {
  // OpenMail and OpenCRM: `ai.chat` plus optional provider pins.
  const openmail = {
    ai: { chat: { why: "Drafts replies." } },
    providers: ["openrouter", "workers-ai"],
    features: { pins: { name: "Pinned models", why: "A pinned build.", providers: ["openrouter", "workers-ai"] } },
  };

  it("lists the default's key once, required, not again as an optional pin", () => {
    const { report } = appSetupFrom({ manifest: openmail, appId: "openmail", gatewayNames: [], secretNames: [] });
    const rows = plain(renderSettingsTable(settingsRows("openmail", report.settings)));
    expect(rows.filter((row) => row.includes("OPENROUTER_API_KEY"))).toEqual([
      expect.stringMatching(/OPENROUTER_API_KEY\s+Gateway\s+! not set$/),
    ]);
    // The other pin is another key: still its own optional row.
    expect(rows.some((row) => row.includes("WORKERS_AI_API_TOKEN") && row.endsWith("not set (optional)"))).toBe(true);
  });

  it("keeps a required pin beside the default: it needs that provider's key", () => {
    const { report } = appSetupFrom({
      manifest: { ai: { chat: true }, providers: [{ id: "openrouter", why: "Web research." }] },
      appId: "crm",
      gatewayNames: [],
      secretNames: [],
    });
    expect(report.settings.map((setting) => setting.kind)).toEqual(["ai-default", "provider"]);
  });
});

describe("helperRows", () => {
  it("gives a helper Worker the app's own rows against what it holds, in the same words", () => {
    const manifest = {
      providers: ["openai"],
      secrets: ["MAIN_SECRET"],
      features: { github: { name: "GitHub", why: "Rate limit.", secrets: ["GITHUB_TOKEN"] } },
    };
    const rows = (settings: Parameters<typeof helperRows>[2]) =>
      helperRows("seo", "audit", settings).map((row) => [row.setting, row.where, stripVTControlCharacters(row.status)]);

    // The helper holds nothing of its own; the Gateway's rows aren't its.
    const { report } = appSetupFrom({ manifest, appId: "seo", gatewayNames: ["OPENAI_API_KEY"], secretNames: [] });
    expect(rows(report.settings)).toEqual([
      ["MAIN_SECRET", "audit helper", "! not set"],
      ["GITHUB_TOKEN", "audit helper", "not set (optional)"],
    ]);

    const bare = appSetupFrom({ manifest, appId: "seo", gatewayNames: [], secretNames: ["MAIN_SECRET"] });
    expect(rows(bare.report.settings)).toEqual([
      ["MAIN_SECRET", "audit helper", "✓ set"],
      ["GITHUB_TOKEN", "audit helper", "not set (optional)"],
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
    expect(setup.unmet.map((setting) => describeUnmet(setting))).toEqual([
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

  it("adds each Gateway setting's setup guide once, and an app's own value's how with its URLs filled", () => {
    const { setup } = appSetupFrom({
      manifest: {
        providers: ["openrouter"],
        capabilities: { "google-workspace": { access: "write" } },
        secrets: ["MAIN_SECRET", { name: "SIGNING_KEY", how: "Paste it at {appUrl}/settings" }],
      },
      appId: "analytics",
      gatewayNames: [],
      secretNames: [],
      lookup: withOAuthPresets(CATALOG),
    });
    expect(describeUnmetSettings(setup.unmet)).toEqual([
      "OpenRouter: OPENROUTER_API_KEY",
      OPENROUTER_HINT,
      "Get it at https://openrouter.ai/settings/keys",
      "Guide: https://everyapp.com/docs/agent/setup/openrouter.md",
      "Google: GOOGLE_WORKSPACE_CLIENT_ID and GOOGLE_WORKSPACE_CLIENT_SECRET",
      "Get it at https://console.cloud.google.com/apis/credentials",
      "Guide: https://everyapp.com/docs/agent/setup/google.md",
      "MAIN_SECRET",
      "SIGNING_KEY",
      "Paste it at {appUrl}/settings",
    ]);
    expect(describeUnmet(setup.unmet.at(-1)!, { appUrl: "https://a.example.com", gatewayUrl: "https://example.com" })).toEqual([
      "SIGNING_KEY",
      "Paste it at https://a.example.com/settings",
    ]);
  });

  it("points at provider show for a provider without a guide (a registered one), and at the skill for a built-in one", () => {
    const { setup } = appSetupFrom({
      manifest: {
        capabilities: {
          northwind: { access: "read", why: "Shows the last charges." },
          dataforseo: { access: "read" },
        },
      },
      appId: "shop",
      gatewayNames: [],
      secretNames: [],
      lookup: NORTHWIND_REGISTRY,
    });
    expect(describeUnmetSettings(setup.unmet)).toEqual([
      "Northwind: Shows the last charges.",
      "A restricted key from the Northwind dashboard. Read access to Charges is enough.",
      "Get it at https://developer.northwind.io/keys",
      "Guide: pnpm everyapp provider show northwind",
      "DataForSEO: DATAFORSEO_API_KEY",
      expect.stringMatching(/^The API login and password/),
      "Get it at https://app.dataforseo.com/api-access",
      "Guide: https://everyapp.com/docs/agent/setup/dataforseo.md",
    ]);
  });
});

/** A gateway's registry with one registered provider, Northwind, with the Gateway's host rule. */
const NORTHWIND_SPEC = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
  hint: "A restricted key from the Northwind dashboard.",
  secrets: [{ name: "NORTHWIND_API_KEY", hint: "Read access to Charges is enough." }],
};
const NORTHWIND_REGISTRY = providerRegistry([{ id: "northwind", spec: NORTHWIND_SPEC }]);

describe("a gateway's registered providers", () => {
  const manifest = { capabilities: { northwind: { access: "read" } }, secrets: ["MAIN_SECRET"] };

  it("are settings like a catalog provider's once the registry is the lookup, and nothing without it", () => {
    expect(declaresSettings({ capabilities: { northwind: { access: "read" } } })).toBe(false);
    expect(declaresSettings({ capabilities: { northwind: { access: "read" } } }, NORTHWIND_REGISTRY)).toBe(true);
    expect(gatewayNamesRead(manifest, NORTHWIND_REGISTRY)).toEqual(["NORTHWIND_API_KEY"]);
    const { setup } = appSetupFrom({
      manifest,
      appId: "shop",
      gatewayNames: [],
      secretNames: ["MAIN_SECRET"],
      lookup: NORTHWIND_REGISTRY,
    });
    expect(setup.unmet.map((setting) => setting.names)).toEqual([["NORTHWIND_API_KEY"]]);
  });

  it("read a key that isn't bound to the row's hosts as not set, as the Gateway reads it", () => {
    const set = { manifest, appId: "shop", gatewayNames: ["NORTHWIND_API_KEY"], secretNames: ["MAIN_SECRET"] };
    // Never bound (just added, or replaced since): the Gateway doesn't read it.
    expect(appSetupFrom({ ...set, lookup: NORTHWIND_REGISTRY }).setup.ready).toBe(false);
    expect(boundGatewayNames(["NORTHWIND_API_KEY", "OPENAI_API_KEY"], NORTHWIND_REGISTRY)).toEqual(["OPENAI_API_KEY"]);
    const parsed = parseProviderSpec(NORTHWIND_SPEC);
    if (!parsed.ok) throw new Error("the spec parses");
    const bound = providerRegistry([
      { id: "northwind", spec: NORTHWIND_SPEC, boundTo: providerBindingKey(parsed.capability) },
    ]);
    expect(appSetupFrom({ ...set, lookup: bound }).setup.ready).toBe(true);
    // The catalog alone has nothing to leave out.
    expect(boundGatewayNames(["NORTHWIND_API_KEY"])).toEqual(["NORTHWIND_API_KEY"]);
  });
});

describe("the setup guides the registries name", () => {
  it("exist in the agent docs, one page per guide", () => {
    const agentDocs = path.resolve(__dirname, "../../../../../landing-page/content/agent");
    const everything = {
      providers: Object.keys(DEV_AI_PROVIDERS),
      // Every capability; the AI providers are listed under `providers`.
      capabilities: Object.fromEntries([
        ...Object.entries(CAPABILITIES).flatMap(([id, capability]) =>
          capability.mode === "ai" ? [] : [[id, { access: capability.access[0] }]],
        ),
        ...oauthPresetIds().map((id) => [id, { scopes: [] }]),
      ]),
    };
    const guides = [
      ...new Set(
        appSettings(everything, withOAuthPresets(CATALOG)).flatMap((setting) => (setting.setup ? [setting.setup] : [])),
      ),
    ];
    expect(guides).toContain("setup/google.md");
    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      expect(fs.existsSync(path.join(agentDocs, guide)), guide).toBe(true);
    }
  });
});
