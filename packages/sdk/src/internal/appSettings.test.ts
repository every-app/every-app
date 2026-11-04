import { describe, expect, it } from "vitest";
import {
  appSettings,
  appSetupOf,
  evaluateAppSettings,
  featureEntries,
  generatedSecret,
  providerEntries,
  providerIds,
  secretEntries,
  secretNames,
  settingEntries,
  setupCommand,
  type AppSetting,
  type SettingHolder,
} from "./appSettings.js";
import { CATALOG } from "./capabilities.js";
import { withOAuthPresets } from "./oauthPresets.js";

/** The catalog with every OAuth preset as its row would be. */
const PRESETS = withOAuthPresets(CATALOG);

/** `isSet` from a list of names set on each holder; null for an app whose names were never recorded. */
function setOn(
  gateway: readonly string[],
  app: readonly string[] | null,
): (holder: SettingHolder, name: string) => boolean | null {
  return (holder, name) =>
    holder === "gateway"
      ? gateway.includes(name)
      : app === null
        ? null
        : app.includes(name);
}

describe("the manifest's declarations", () => {
  it("reads providers and secrets by id or as entries, and defaults their need to required", () => {
    expect(
      providerEntries({
        providers: ["openrouter", { id: "workers-ai", why: "Runs the agent." }],
      }),
    ).toEqual([
      { id: "openrouter" },
      { id: "workers-ai", why: "Runs the agent." },
    ]);
    expect(
      providerIds({ providers: ["openai", { id: "openrouter" }] }),
    ).toEqual(["openai", "openrouter"]);
    expect(
      secretEntries({
        secrets: [
          "MAIN_SECRET",
          {
            name: "GITHUB_TOKEN",
            docs: "https://github.com/settings/tokens",
            how: "Settings → Tokens",
            generate: true,
          },
        ],
      }),
    ).toEqual([
      { name: "MAIN_SECRET" },
      {
        name: "GITHUB_TOKEN",
        docs: "https://github.com/settings/tokens",
        how: "Settings → Tokens",
        generate: true,
      },
    ]);
    expect(secretNames({ secrets: ["A", { name: "B" }] })).toEqual(["A", "B"]);
    expect(secretNames({})).toEqual([]);
  });

  it("reads features in order with their defaults, and their values tagged with the feature", () => {
    const manifest = {
      secrets: ["TOP"],
      settings: [{ name: "HOST", why: "Where." }],
      features: {
        github: {
          name: "GitHub",
          required: true,
          why: "Pushes branches.",
          steps: ["Create an App: {appUrl}"],
          settings: [{ name: "GITHUB_APP_ID", how: "General → App ID" }],
          secrets: [
            { name: "GITHUB_APP_PRIVATE_KEY", file: true },
            "GITHUB_WEBHOOK_SECRET",
          ],
          capabilities: ["slack"],
        },
        bare: {},
      },
    };
    expect(featureEntries(manifest)).toEqual([
      {
        id: "github",
        name: "GitHub",
        required: true,
        why: "Pushes branches.",
        steps: ["Create an App: {appUrl}"],
        capabilities: ["slack"],
        providers: [],
      },
      {
        id: "bare",
        name: "bare",
        required: false,
        steps: [],
        capabilities: [],
        providers: [],
      },
    ]);
    expect(featureEntries({})).toEqual([]);
    expect(secretEntries(manifest)).toEqual([
      { name: "TOP" },
      { name: "GITHUB_APP_PRIVATE_KEY", file: true, feature: "github" },
      { name: "GITHUB_WEBHOOK_SECRET", feature: "github" },
    ]);
    expect(settingEntries(manifest)).toEqual([
      { name: "HOST", why: "Where." },
      { name: "GITHUB_APP_ID", how: "General → App ID", feature: "github" },
    ]);
  });

  it("skips entries it can't read, as a stored manifest from another CLI might hold", () => {
    expect(
      providerEntries({ providers: [{ nope: 1 } as never, 3 as never] }),
    ).toEqual([]);
    expect(secretEntries({ secrets: [null as never] })).toEqual([]);
  });
});

describe("appSettings", () => {
  it("lists every setting in manifest order with its holder, names and default docs", () => {
    const settings = appSettings(
      {
        providers: ["workers-ai", { id: "openrouter", why: "SAM." }],
        capabilities: {
          dataforseo: { access: "read", why: "Keyword data." },
          context: { access: "read" },
          email: { access: "write" },
          members: { access: "read" },
          slack: { access: "write" },
          "google-workspace": {
            access: "write",
            docs: "https://example.com/google",
          },
        },
        secrets: ["MAIN_SECRET"],
        features: {
          rendering: { name: "Rendering", capabilities: ["context"] },
          google: { name: "Google", capabilities: ["google-workspace"] },
          github: {
            name: "GitHub",
            secrets: [{ name: "GITHUB_TOKEN", why: "Raises the rate limit." }],
          },
        },
      },
      PRESETS,
    );
    expect(
      settings.map((setting) => [
        setting.kind,
        setting.id,
        setting.holder,
        setting.names,
        setting.alsoReads,
        setting.need,
      ]),
    ).toEqual([
      // Workers AI's CLOUDFLARE_ACCOUNT_ID is the install's: never asked for.
      [
        "provider",
        "workers-ai",
        "gateway",
        ["WORKERS_AI_API_TOKEN"],
        [],
        { kind: "required" },
      ],
      [
        "provider",
        "openrouter",
        "gateway",
        ["OPENROUTER_API_KEY"],
        [],
        { kind: "required" },
      ],
      [
        "capability",
        "dataforseo",
        "gateway",
        ["DATAFORSEO_API_KEY"],
        [],
        { kind: "required" },
      ],
      [
        "capability",
        "context",
        "gateway",
        ["CONTEXT_API_KEY"],
        [],
        { kind: "optional" },
      ],
      [
        "capability",
        "email",
        "gateway",
        // The sender needs a display name: both names, so every surface
        // asks for both (the Name <address> form of EMAIL_FROM is read too).
        ["EMAIL_FROM", "EMAIL_FROM_NAME"],
        ["EMAIL_REST_API_TOKEN", "RESEND_API_KEY", "EMAIL_PROVIDER"],
        { kind: "required" },
      ],
      ["capability", "members", "gateway", [], [], { kind: "required" }],
      [
        "capability",
        "slack",
        "gateway",
        ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
        [],
        { kind: "required" },
      ],
      [
        "capability",
        "google-workspace",
        "gateway",
        ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
        [],
        { kind: "optional" },
      ],
      [
        "secret",
        "MAIN_SECRET",
        "app",
        ["MAIN_SECRET"],
        [],
        { kind: "required" },
      ],
      [
        "secret",
        "GITHUB_TOKEN",
        "app",
        ["GITHUB_TOKEN"],
        [],
        { kind: "optional" },
      ],
    ]);
    const byId = Object.fromEntries(
      settings.map((setting) => [setting.id, setting]),
    );
    expect(byId["workers-ai"]!.label).toBe("Workers AI");
    expect(byId["openrouter"]!.why).toBe("SAM.");
    expect(byId["openrouter"]!.docs).toBe(
      "https://openrouter.ai/settings/keys",
    );
    expect(byId["dataforseo"]!.label).toBe("DataForSEO");
    expect(byId["dataforseo"]!.docs).toBe(
      "https://app.dataforseo.com/api-access",
    );
    expect(byId["dataforseo"]!.why).toBe("Keyword data.");
    // An OAuth client's console; the manifest's docs win over it.
    expect(byId["slack"]!.docs).toBe("https://api.slack.com/apps");
    expect(byId["google-workspace"]!.docs).toBe("https://example.com/google");
    expect(byId["email"]!.docs).toBeUndefined();
    expect(byId["GITHUB_TOKEN"]!.why).toBe("Raises the rate limit.");
    expect(byId["GITHUB_TOKEN"]!.docs).toBeUndefined();
    // The everyapp skill's setup guides: the registries' for Gateway settings.
    expect(byId["dataforseo"]!.setup).toBe("setup/dataforseo.md");
    expect(byId["workers-ai"]!.setup).toBe("setup/workers-ai.md");
    expect(byId["email"]!.setup).toBe("setup/email.md");
    expect(byId["google-workspace"]!.setup).toBe("setup/google.md");
    expect(byId["members"]!.setup).toBeUndefined();
    expect(byId["slack"]!.setup).toBe("setup/slack.md");
    expect(byId["MAIN_SECRET"]!.setup).toBeUndefined();
  });

  it("never takes a setup guide from the manifest: the registry's for a Gateway setting, none for the app's own", () => {
    const settings = appSettings({
      providers: [{ id: "openai", setup: "setup/mine.md" } as never],
      secrets: [
        { name: "MAIN_SECRET", setup: "docs/setup/main-secret.md" } as never,
      ],
    });
    expect(settings[0]!.setup).toBe("setup/openai.md");
    expect(settings[1]!.setup).toBeUndefined();
  });

  it("gives each value its feature's need: required, optional, or required at the top level; a default is optional", () => {
    const settings = appSettings(
      {
        providers: ["openai", "openrouter"],
        capabilities: {
          slack: { access: "write" },
          dataforseo: { access: "read" },
        },
        secrets: [{ name: "TOP", generate: true }],
        settings: [{ name: "REGION", why: "Where.", default: "us" }],
        features: {
          github: {
            name: "GitHub",
            required: true,
            settings: [{ name: "GITHUB_APP_ID", how: "App ID on {appUrl}" }],
            secrets: [{ name: "GITHUB_KEY", file: true }],
            capabilities: ["dataforseo"],
          },
          slack: {
            name: "Slack",
            secrets: [
              { name: "SLACK_SIGNING_SECRET", generate: true, how: "Paste it" },
            ],
            settings: [{ name: "SLACK_MODE", default: "socket" }],
            capabilities: ["slack"],
            providers: ["openrouter"],
          },
        },
      },
      PRESETS,
    );
    expect(
      settings.map((setting) => [
        setting.id,
        setting.need.kind,
        setting.feature ?? null,
      ]),
    ).toEqual([
      ["openai", "required", null],
      ["openrouter", "optional", "slack"],
      ["slack", "optional", "slack"],
      ["dataforseo", "required", "github"],
      ["TOP", "required", null],
      ["GITHUB_KEY", "required", "github"],
      ["SLACK_SIGNING_SECRET", "optional", "slack"],
      ["REGION", "optional", null],
      ["GITHUB_APP_ID", "required", "github"],
      ["SLACK_MODE", "optional", "slack"],
    ]);
    const byId = Object.fromEntries(
      settings.map((setting) => [setting.id, setting]),
    );
    expect(byId["TOP"]).toMatchObject({ generate: true });
    expect(byId["GITHUB_KEY"]).toMatchObject({ file: true });
    expect(byId["SLACK_SIGNING_SECRET"]).toMatchObject({
      generate: true,
      how: "Paste it",
    });
    expect(byId["GITHUB_APP_ID"]).toMatchObject({ how: "App ID on {appUrl}" });
  });

  it("contributes nothing for a provider or capability the gateway doesn't offer, or a manifest with none", () => {
    expect(appSettings({})).toEqual([]);
    expect(
      appSettings({
        providers: ["nope"],
        capabilities: { northwind: { access: "read" } },
      }),
    ).toEqual([]);
  });
});

describe("the default model and its pins", () => {
  it("lists an optional pin that needs only the default's key once, as the default", () => {
    const settings = appSettings({
      ai: { chat: true },
      providers: ["openrouter", "workers-ai"],
      features: {
        pins: { name: "Pins", providers: ["openrouter", "workers-ai"] },
      },
    });
    expect(settings.map((setting) => [setting.kind, setting.id])).toEqual([
      ["ai-default", "ai-default"],
      ["provider", "workers-ai"],
    ]);
    expect(settings[0]).toMatchObject({
      names: ["OPENROUTER_API_KEY"],
      need: { kind: "required" },
    });
  });

  it("keeps a required pin, which needs its own key whatever serves the default", () => {
    const settings = appSettings({
      ai: { chat: true },
      providers: [{ id: "openrouter" }],
    });
    expect(settings.map((setting) => setting.kind)).toEqual([
      "ai-default",
      "provider",
    ]);
  });
});

describe("evaluateAppSettings", () => {
  const inbox = appSettings({
    providers: ["openrouter"],
    capabilities: { email: { access: "write" } },
  });
  const crm = appSettings(
    {
      providers: ["openrouter"],
      capabilities: {
        context: { access: "read" },
        slack: { access: "write" },
      },
      secrets: ["TOKEN_ENCRYPTION_KEY"],
      features: {
        slack: { name: "Slack", capabilities: ["slack"] },
        github: { name: "GitHub", secrets: ["GITHUB_TOKEN"] },
      },
    },
    PRESETS,
  );

  it("is ready when every required setting is set", () => {
    const report = evaluateAppSettings(
      inbox,
      setOn(["OPENROUTER_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"], []),
    );
    expect(report.ready).toBe(true);
    expect(report.unmet).toEqual([]);
    expect(report.features).toEqual([]);
    expect(
      report.settings.map((setting) => [
        setting.id,
        setting.set,
        setting.blocking,
      ]),
    ).toEqual([
      ["openrouter", true, false],
      ["email", true, false],
    ]);
  });

  it("blocks on a required setting that is unset, never on an optional feature's", () => {
    const report = evaluateAppSettings(
      crm,
      setOn(["OPENROUTER_API_KEY"], ["TOKEN_ENCRYPTION_KEY"]),
    );
    expect(report.ready).toBe(false);
    expect(report.unmet.map((setting) => setting.id)).toEqual(["context"]);
    expect(
      report.settings.find((setting) => setting.id === "slack"),
    ).toMatchObject({ set: false, blocking: false });
    expect(
      report.settings.find((setting) => setting.id === "GITHUB_TOKEN"),
    ).toMatchObject({ set: false, blocking: false });
  });

  it("counts a setting set only when every one of its names is", () => {
    const slack = appSettings(
      { capabilities: { slack: { access: "write" } } },
      PRESETS,
    );
    const report = evaluateAppSettings(slack, setOn(["SLACK_CLIENT_ID"], []));
    expect(report.ready).toBe(false);
    expect(report.unmet.map((setting) => setting.id)).toEqual(["slack"]);
  });

  it("lets a capability's own readiness rule override its names", () => {
    const report = evaluateAppSettings(
      inbox,
      setOn(["OPENROUTER_API_KEY", "EMAIL_FROM"], []),
      {
        readiness: (setting) => (setting.id === "email" ? false : undefined),
      },
    );
    expect(report.unmet.map((setting) => setting.id)).toEqual(["email"]);
    const ready = evaluateAppSettings(
      inbox,
      setOn(["OPENROUTER_API_KEY"], []),
      {
        readiness: (setting) => (setting.id === "email" ? true : undefined),
      },
    );
    expect(ready.ready).toBe(true);
  });

  it("never blocks on what it can't know: an app Worker whose secret names were never recorded", () => {
    const report = evaluateAppSettings(
      crm,
      setOn(["OPENROUTER_API_KEY", "CONTEXT_API_KEY"], null),
    );
    expect(report.ready).toBe(true);
    expect(
      report.settings.find((setting) => setting.id === "TOKEN_ENCRYPTION_KEY"),
    ).toMatchObject({ set: null, blocking: false });
  });

  it("is ready for a capability with nothing to set", () => {
    const members = appSettings({
      capabilities: { members: { access: "read" } },
    });
    expect(evaluateAppSettings(members, setOn([], [])).ready).toBe(true);
  });
});

describe("feature states", () => {
  const manifest = {
    capabilities: {
      slack: { access: "write" },
      dataforseo: { access: "read" },
    },
    features: {
      github: {
        name: "GitHub",
        required: true,
        settings: [{ name: "GITHUB_APP_ID" }],
        secrets: ["GITHUB_KEY"],
      },
      slack: {
        name: "Slack",
        secrets: ["SLACK_SIGNING_SECRET"],
        settings: [{ name: "SLACK_MODE", default: "socket" }],
        capabilities: ["slack"],
      },
      seo: { name: "SEO", capabilities: ["dataforseo"] },
    },
  };
  const evaluate = (gateway: string[], app: string[] | null) =>
    evaluateAppSettings(appSettings(manifest, PRESETS), setOn(gateway, app), {
      features: featureEntries(manifest),
    });
  const states = (report: ReturnType<typeof evaluate>) =>
    report.features.map((feature) => [feature.id, feature.state]);

  it("is off while none of its own values is set, a default and a shared Gateway key not counting", () => {
    const report = evaluate(
      ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
      ["SLACK_MODE"],
    );
    expect(states(report)).toEqual([
      ["github", "off"],
      ["slack", "off"],
      ["seo", "off"],
    ]);
    // The required feature blocks; the optional ones never do.
    expect(report.unmet.map((setting) => setting.id)).toEqual([
      "GITHUB_KEY",
      "GITHUB_APP_ID",
    ]);
    expect(report.features[1]!.settings.map((setting) => setting.id)).toEqual([
      "slack",
      "SLACK_SIGNING_SECRET",
      "SLACK_MODE",
    ]);
  });

  it("is incomplete while some are set, ready once every value and Gateway setting is", () => {
    const half = evaluate(
      [],
      ["GITHUB_KEY", "SLACK_SIGNING_SECRET", "SLACK_MODE"],
    );
    expect(states(half)).toEqual([
      ["github", "incomplete"],
      ["slack", "incomplete"],
      ["seo", "off"],
    ]);
    expect(half.ready).toBe(false);
    const all = evaluate(
      ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "DATAFORSEO_API_KEY"],
      ["GITHUB_KEY", "GITHUB_APP_ID", "SLACK_SIGNING_SECRET", "SLACK_MODE"],
    );
    expect(states(all)).toEqual([
      ["github", "ready"],
      ["slack", "ready"],
      ["seo", "ready"],
    ]);
    expect(all.ready).toBe(true);
  });

  it("reads a feature of Gateway settings alone from those, and unknown values as not unset", () => {
    expect(states(evaluate(["DATAFORSEO_API_KEY"], null))).toEqual([
      ["github", "ready"],
      ["slack", "off"],
      ["seo", "ready"],
    ]);
  });
});

describe("generatedSecret", () => {
  it("is 32 random bytes, base64url, fresh each call", () => {
    const one = generatedSecret();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generatedSecret()).not.toBe(one);
  });
});

describe("setupCommand and appSetupOf", () => {
  const cli = "pnpm everyapp";

  it("is the one configure command for the app, whatever is unmet", () => {
    const settings: AppSetting[] = appSettings({
      providers: ["workers-ai", "openrouter"],
      capabilities: {
        dataforseo: { access: "read" },
        email: { access: "write" },
      },
      secrets: ["MAIN_SECRET"],
      features: { github: { name: "GitHub", secrets: ["GITHUB_TOKEN"] } },
    });
    const report = evaluateAppSettings(settings, setOn([], []));
    // Configure asks for each unmet setting itself, so the command names
    // no setting.
    expect(setupCommand(report, { cli, appId: "seo" })).toEqual({
      command: "pnpm everyapp configure seo",
    });
    const gatewayOnly = evaluateAppSettings(
      appSettings({ providers: ["openai"], secrets: ["MAIN_SECRET"] }),
      setOn([], ["MAIN_SECRET"]),
    );
    expect(setupCommand(gatewayOnly, { cli, appId: "todo" })).toEqual({
      command: "pnpm everyapp configure todo",
    });
  });

  it("names the key to set for a provider app, which has nothing to configure", () => {
    const report = evaluateAppSettings(
      appSettings({ capabilities: { dataforseo: { access: "read" } } }),
      setOn([], []),
    );
    expect(
      setupCommand(report, { cli, appId: "dataforseo", provider: true }),
    ).toEqual({
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
    });
    expect(
      appSetupOf(report, { cli, appId: "dataforseo", provider: true }).command,
    ).toEqual({ command: "pnpm everyapp secret set DATAFORSEO_API_KEY" });
  });

  it("is null for an app that is ready", () => {
    const report = evaluateAppSettings(
      appSettings({ providers: ["openai"] }),
      setOn(["OPENAI_API_KEY"], []),
    );
    expect(setupCommand(report, { cli, appId: "todo" })).toBeNull();
  });

  it("summarizes the report for every surface, with or without the command", () => {
    const manifest = {
      providers: ["workers-ai", "openrouter"],
      secrets: ["MAIN_SECRET"],
      features: {
        pin: {
          name: "Workers AI pin",
          why: "A pinned model.",
          providers: ["workers-ai"],
        },
      },
    };
    const report = evaluateAppSettings(
      appSettings(manifest),
      setOn(["OPENROUTER_API_KEY"], []),
      { features: featureEntries(manifest) },
    );
    const setup = appSetupOf(report, { cli, appId: "inbox" });
    expect(setup.ready).toBe(false);
    expect(setup.settings.map((setting) => setting.id)).toEqual([
      "workers-ai",
      "openrouter",
      "MAIN_SECRET",
    ]);
    expect(setup.settings[0]).not.toHaveProperty("alsoReads");
    expect(setup.unmet.map((setting) => setting.id)).toEqual(["MAIN_SECRET"]);
    expect(setup.features).toEqual([
      {
        id: "pin",
        name: "Workers AI pin",
        required: false,
        why: "A pinned model.",
        steps: [],
        capabilities: [],
        providers: ["workers-ai"],
        state: "off",
        settings: ["workers-ai"],
      },
    ]);
    expect(setup.command).toEqual({
      command: "pnpm everyapp configure inbox",
    });
    expect(
      appSetupOf(report, { cli, appId: "inbox", withCommand: false }).command,
    ).toBeNull();
  });
});
