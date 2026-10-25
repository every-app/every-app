import { describe, expect, it } from "vitest";
import {
  appSettings,
  appSetupOf,
  evaluateAppSettings,
  needOf,
  providerEntries,
  providerIds,
  secretEntries,
  secretNames,
  setupCommand,
  type AppSetting,
  type SettingHolder,
} from "./appSettings.js";

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
        providers: [
          "openrouter",
          { id: "workers-ai", anyOf: "AI model", why: "Runs the agent." },
        ],
      }),
    ).toEqual([
      { id: "openrouter" },
      { id: "workers-ai", anyOf: "AI model", why: "Runs the agent." },
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
            optional: true,
            docs: "https://github.com/settings/tokens",
          },
        ],
      }),
    ).toEqual([
      { name: "MAIN_SECRET" },
      {
        name: "GITHUB_TOKEN",
        optional: true,
        docs: "https://github.com/settings/tokens",
      },
    ]);
    expect(secretNames({ secrets: ["A", { name: "B" }] })).toEqual(["A", "B"]);
    expect(secretNames({})).toEqual([]);
    expect(needOf(undefined)).toEqual({ kind: "required" });
    expect(needOf({})).toEqual({ kind: "required" });
    expect(needOf({ optional: false })).toEqual({ kind: "required" });
    expect(needOf({ optional: true })).toEqual({ kind: "optional" });
    // A group wins over `optional`; the validator refuses both anyway.
    expect(needOf({ optional: true, anyOf: " AI model " })).toEqual({
      kind: "anyOf",
      group: "AI model",
    });
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
    const settings = appSettings({
      providers: ["workers-ai", { id: "openrouter", why: "SAM." }],
      capabilities: {
        dataforseo: { access: "read", why: "Keyword data." },
        context: { access: "read", optional: true },
        email: { access: "write" },
        members: { access: "read" },
        mastodon: { access: "write" },
        "google-workspace": {
          access: "write",
          optional: true,
          docs: "https://example.com/google",
        },
      },
      ai: { routes: ["/v1/files"] },
      secrets: [
        "MAIN_SECRET",
        { name: "GITHUB_TOKEN", optional: true, why: "Raises the rate limit." },
      ],
    });
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
      // The instance has a default: read when set.
      [
        "capability",
        "mastodon",
        "gateway",
        ["MASTODON_CLIENT_ID", "MASTODON_CLIENT_SECRET"],
        ["MASTODON_URL"],
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
        "ai-routes",
        "ai-routes",
        "gateway",
        ["AI_PROXY_EXTRA_ROUTES"],
        [],
        { kind: "required" },
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
    expect(byId["mastodon"]!.docs).toMatch(/^https:\/\//);
    expect(byId["google-workspace"]!.docs).toBe("https://example.com/google");
    expect(byId["email"]!.docs).toBeUndefined();
    expect(byId["ai-routes"]!.why).toContain("/v1/files");
    expect(byId["GITHUB_TOKEN"]!.why).toBe("Raises the rate limit.");
    expect(byId["GITHUB_TOKEN"]!.docs).toBeUndefined();
    // The everyapp skill's setup guides: the registries' for Gateway settings.
    expect(byId["dataforseo"]!.setup).toBe("setup/dataforseo.md");
    expect(byId["workers-ai"]!.setup).toBe("setup/workers-ai.md");
    expect(byId["email"]!.setup).toBe("setup/email.md");
    expect(byId["google-workspace"]!.setup).toBe("setup/google.md");
    expect(byId["members"]!.setup).toBeUndefined();
    expect(byId["mastodon"]!.setup).toBeUndefined();
    expect(byId["ai-routes"]!.setup).toBe("setup/openai.md");
    expect(byId["MAIN_SECRET"]!.setup).toBeUndefined();
  });

  it("takes an app secret's setup guide from its entry, and never a Gateway setting's", () => {
    const settings = appSettings({
      providers: [{ id: "openai", setup: "setup/mine.md" } as never],
      secrets: [{ name: "MAIN_SECRET", setup: "setup/main-secret.md" }],
    });
    expect(settings[0]!.setup).toBe("setup/openai.md");
    expect(settings[1]!.setup).toBe("setup/main-secret.md");
  });

  it("contributes nothing for a provider or capability the gateway doesn't offer, or a manifest with none", () => {
    expect(appSettings({})).toEqual([]);
    expect(
      appSettings({
        providers: ["nope"],
        capabilities: { northwind: { access: "read" } },
        ai: { routes: [] },
      }),
    ).toEqual([]);
  });
});

describe("evaluateAppSettings", () => {
  const inbox = appSettings({
    providers: [
      { id: "workers-ai", anyOf: "AI model" },
      { id: "openrouter", anyOf: "AI model" },
    ],
    capabilities: { email: { access: "write" } },
  });
  const crm = appSettings({
    providers: ["openrouter"],
    capabilities: {
      context: { access: "read" },
      slack: { access: "write", optional: true },
    },
    secrets: ["TOKEN_ENCRYPTION_KEY", { name: "GITHUB_TOKEN", optional: true }],
  });

  it("is ready when every required setting is set and each any-of group has a member set", () => {
    const report = evaluateAppSettings(
      inbox,
      setOn(["OPENROUTER_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"], []),
    );
    expect(report.ready).toBe(true);
    expect(report.unmet).toEqual([]);
    expect(report.groups).toEqual([
      expect.objectContaining({ group: "AI model", met: true }),
    ]);
    expect(
      report.settings.map((setting) => [
        setting.id,
        setting.set,
        setting.blocking,
      ]),
    ).toEqual([
      ["workers-ai", false, false],
      ["openrouter", true, false],
      ["email", true, false],
    ]);
  });

  it("blocks on a required setting that is unset, never on an optional one", () => {
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

  it("blocks on every member of a any-of group while none is set", () => {
    const report = evaluateAppSettings(
      inbox,
      setOn(["EMAIL_FROM", "EMAIL_FROM_NAME"], []),
    );
    expect(report.ready).toBe(false);
    expect(report.unmet.map((setting) => setting.id)).toEqual([
      "workers-ai",
      "openrouter",
    ]);
    expect(report.groups[0]).toMatchObject({ group: "AI model", met: false });
  });

  it("counts a setting set only when every one of its names is", () => {
    const mastodon = appSettings({
      capabilities: { mastodon: { access: "write" } },
    });
    const report = evaluateAppSettings(
      mastodon,
      setOn(["MASTODON_CLIENT_ID"], []),
    );
    expect(report.ready).toBe(false);
    expect(report.unmet.map((setting) => setting.id)).toEqual(["mastodon"]);
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
    // A any-of group with an unknown member and no set one is unknown too.
    const group = evaluateAppSettings(
      appSettings({
        secrets: [
          { name: "A", anyOf: "a key" },
          { name: "B", anyOf: "a key" },
        ],
      }),
      setOn([], null),
    );
    expect(group.ready).toBe(true);
    expect(group.groups[0]!.met).toBe(false);
  });

  it("is ready for a capability with nothing to set", () => {
    const members = appSettings({
      capabilities: { members: { access: "read" } },
    });
    expect(evaluateAppSettings(members, setOn([], [])).ready).toBe(true);
  });
});

describe("setupCommand and appSetupOf", () => {
  const cli = "pnpm everyapp";

  it("is the one configure command for the app, whatever is unmet", () => {
    const settings: AppSetting[] = appSettings({
      providers: [
        { id: "workers-ai", anyOf: "AI model" },
        { id: "openrouter", anyOf: "AI model" },
      ],
      capabilities: {
        dataforseo: { access: "read" },
        email: { access: "write" },
      },
      secrets: ["MAIN_SECRET", { name: "GITHUB_TOKEN", optional: true }],
    });
    const report = evaluateAppSettings(settings, setOn([], []));
    // Configure asks for each unmet setting itself, so the command names
    // no setting, and an unmet any-of group needs no note: it asks which.
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

  it("is the same command when only an any-of group is unmet", () => {
    const report = evaluateAppSettings(
      appSettings({
        providers: [{ id: "openrouter", anyOf: "AI model" }],
        secrets: [{ name: "ANTHROPIC_API_KEY", anyOf: "AI model" }],
      }),
      setOn([], []),
    );
    expect(setupCommand(report, { cli, appId: "inbox" })).toEqual({
      command: "pnpm everyapp configure inbox",
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
    const report = evaluateAppSettings(
      appSettings({
        providers: [
          { id: "workers-ai", anyOf: "AI model" },
          { id: "openrouter", anyOf: "AI model" },
        ],
        secrets: ["MAIN_SECRET"],
      }),
      setOn(["OPENROUTER_API_KEY"], []),
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
    expect(setup.groups).toEqual([
      { group: "AI model", met: true, members: ["workers-ai", "openrouter"] },
    ]);
    expect(setup.command).toEqual({
      command: "pnpm everyapp configure inbox",
    });
    expect(
      appSetupOf(report, { cli, appId: "inbox", withCommand: false }).command,
    ).toBeNull();
  });
});
