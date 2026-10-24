import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  appIsReady,
  appSetupFor,
  appSettingsReport,
  resetAppSetupCacheForTests,
  type AppSetupDeps,
  type AppSetupInput,
} from "./app-setup";

const OPENSEO = {
  id: "openseo",
  providers: ["openrouter"],
  capabilities: {
    dataforseo: { access: "read", why: "Keyword data." },
    context: { access: "read", optional: true },
  },
};

const ANALYTICS = {
  id: "analytics",
  secrets: ["MAIN_SECRET"],
  capabilities: {
    members: { access: "read" },
    email: { access: "write", optional: true },
  },
};

const INBOX = {
  id: "inbox",
  providers: ["openrouter"],
  capabilities: { email: { access: "write" } },
};

function input(
  manifest: unknown,
  overrides: Partial<AppSetupInput> = {},
): AppSetupInput {
  const id = (manifest as { id: string }).id;
  return {
    rowId: `row-${id}`,
    versionId: "v1",
    secretNames: null,
    appId: id,
    tier: "service_binding",
    manifest,
    canFix: true,
    ...overrides,
  };
}

function deps(
  settings: Record<string, unknown>,
  emailConfigured = false,
): AppSetupDeps {
  return { settings, emailConfigured: async () => emailConfigured };
}

describe("appSetupFor", () => {
  beforeEach(() => resetAppSetupCacheForTests());

  it("is null for an app that declares nothing to set, or whose manifest can't be read", async () => {
    expect(await appSetupFor(input({ id: "todo" }), deps({}))).toBeNull();
    expect(
      await appSetupFor(
        input({ id: "todo" }, { manifest: "{not json" }),
        deps({}),
      ),
    ).toBeNull();
    expect(
      await appSetupFor(input({ id: "todo" }, { manifest: null }), deps({})),
    ).toBeNull();
  });

  it("says what is unmet and the one command that opens the app, from the Gateway's env", async () => {
    const setup = await appSetupFor(
      input(OPENSEO),
      deps({ OPENROUTER_API_KEY: "sk", CONTEXT_API_KEY: "" }),
    );
    expect(setup).toMatchObject({ ready: false });
    expect(setup!.unmet.map((setting) => setting.id)).toEqual(["dataforseo"]);
    expect(setup!.unmet[0]).toMatchObject({
      label: "DataForSEO",
      names: ["DATAFORSEO_API_KEY"],
      why: "Keyword data.",
      docs: "https://app.dataforseo.com/api-access",
    });
    expect(
      setup!.settings.find((setting) => setting.id === "context"),
    ).toMatchObject({ set: false, blocking: false });
    expect(setup!.command).toEqual({
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
    });
  });

  it("reads the stored manifest's JSON as the row holds it", async () => {
    const setup = await appSetupFor(
      input(OPENSEO, { manifest: JSON.stringify(OPENSEO) }),
      deps({
        OPENROUTER_API_KEY: "sk",
        DATAFORSEO_API_KEY: "login:password",
      }),
    );
    expect(setup).toMatchObject({ ready: true, command: null });
  });

  it("takes the app's own secrets from the recorded names, and never blocks on names never recorded", async () => {
    const unknown = await appSetupFor(input(ANALYTICS), deps({}));
    expect(unknown).toMatchObject({ ready: true, command: null });
    expect(
      unknown!.settings.find((setting) => setting.id === "MAIN_SECRET"),
    ).toMatchObject({ set: null, blocking: false });

    const unset = await appSetupFor(
      input(ANALYTICS, { secretNames: [] }),
      deps({}),
    );
    expect(unset!.ready).toBe(false);
    expect(unset!.command).toEqual({
      command: "pnpm everyapp secret set MAIN_SECRET --app analytics",
    });

    const set = await appSetupFor(
      input(ANALYTICS, { secretNames: ["MAIN_SECRET"] }),
      deps({}),
    );
    expect(set!.ready).toBe(true);
  });

  it("counts email configured by the gateway's own rule, not by its setting names", async () => {
    const unconfigured = await appSetupFor(
      input(INBOX),
      deps({ OPENROUTER_API_KEY: "sk", EMAIL_FROM: "hi@example.com" }, false),
    );
    expect(unconfigured!.unmet.map((setting) => setting.id)).toEqual(["email"]);
    const configured = await appSetupFor(
      input(INBOX, { rowId: "row-inbox-2" }),
      deps({ OPENROUTER_API_KEY: "sk" }, true),
    );
    expect(configured!.ready).toBe(true);
  });

  it("leaves the command out for a reader who can't run it", async () => {
    const setup = await appSetupFor(
      input(OPENSEO, { canFix: false }),
      deps({}),
    );
    expect(setup!.ready).toBe(false);
    expect(setup!.unmet.length).toBeGreaterThan(0);
    expect(setup!.command).toBeNull();
  });

  it("doesn't evaluate a dispatch-tier app", async () => {
    expect(
      await appSetupFor(input(OPENSEO, { tier: "dispatch" }), deps({})),
    ).toBeNull();
    expect(
      await appIsReady(input(OPENSEO, { tier: "dispatch" }), deps({})),
    ).toBe(true);
  });

  it("caches the report by row, version and recorded names", async () => {
    const first = await appSettingsReport(input(ANALYTICS), deps({}));
    const again = await appSettingsReport(input(ANALYTICS), deps({}));
    expect(again).toBe(first);
    const recorded = await appSettingsReport(
      input(ANALYTICS, { secretNames: ["MAIN_SECRET"] }),
      deps({}),
    );
    expect(recorded).not.toBe(first);
    const redeployed = await appSettingsReport(
      input(ANALYTICS, { versionId: "v2" }),
      deps({}),
    );
    expect(redeployed).not.toBe(first);
    expect(await appIsReady(input(ANALYTICS), deps({}))).toBe(true);
  });
});
