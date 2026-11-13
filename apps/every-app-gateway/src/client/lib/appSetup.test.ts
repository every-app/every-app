/**
 * The setup dialog's wording from an app's `setup`, built with the SDK's
 * own model so the dialog follows what the gateway evaluates.
 */
import { describe, expect, it } from "vitest";
import {
  appSettings,
  appSetupOf,
  CATALOG,
  evaluateAppSettings,
  featureEntries,
  withOAuthPresets,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import {
  inlineParts,
  SetupAction,
  setupDialogModel as model_,
  type SetupUrls,
} from "./appSetup";

const URLS: SetupUrls = {
  appUrl: "https://openseo.acme.com",
  gatewayUrl: "https://acme.com",
};

const setupDialogModel = (
  setup: Parameters<typeof model_>[0],
  options: { name: string; canRun: boolean },
) => model_(setup, { ...options, urls: URLS });

const OPENSEO: SettingsManifestLike & { id: string } = {
  id: "openseo",
  providers: ["openrouter"],
  capabilities: {
    dataforseo: { access: "read", why: "Keyword data." },
    context: { access: "read", why: "JS rendering in audits." },
  },
  features: {
    rendering: {
      name: "Rendering",
      why: "Audits of JS sites.",
      capabilities: ["context"],
    },
  },
};

/** An app with a secret of its own, which the CLI records on its Worker. */
const RESEARCH: SettingsManifestLike & { id: string } = {
  id: "research",
  providers: ["openrouter"],
  secrets: [{ name: "MAIN_SECRET", why: "Signs share links." }],
  features: {
    webhooks: {
      name: "Webhooks",
      why: "Receives events.",
      secrets: ["WEBHOOK_SECRET"],
    },
  },
};

/** The app's setup as the gateway lists it, with these names set. */
function setupOf(
  manifest: SettingsManifestLike & { id: string },
  set: readonly string[],
  withCommand = true,
) {
  // The registry as a deploy leaves it: an OAuth preset the app lists is a row.
  const report = evaluateAppSettings(
    appSettings(manifest, withOAuthPresets(CATALOG)),
    (_holder, name) => set.includes(name),
    { features: featureEntries(manifest) },
  );
  return appSetupOf(report, {
    cli: "pnpm everyapp",
    appId: manifest.id,
    withCommand,
  });
}

describe("setupDialogModel", () => {
  it("gives whoever runs it the steps: what is needed, ticked off when set, and the one command", () => {
    const model = setupDialogModel(setupOf(OPENSEO, ["OPENROUTER_API_KEY"]), {
      name: "OpenSEO",
      canRun: true,
    });
    expect(model.action).toEqual({
      kind: SetupAction.Run,
      command: "pnpm everyapp configure openseo",
    });
    expect(model.title).toBe("Set up OpenSEO");
    // What is left to get; OpenRouter is already set.
    expect(model.gather).toBe("Get 1 key");
    expect(model.always).toEqual([
      {
        id: "openrouter",
        label: "OpenRouter",
        names: ["OPENROUTER_API_KEY"],
        why: null,
        takes: null,
        docs: {
          href: "https://openrouter.ai/settings/keys",
          host: "openrouter.ai",
        },
        how: null,
        done: true,
      },
      {
        id: "dataforseo",
        label: "DataForSEO",
        names: ["DATAFORSEO_API_KEY"],
        why: "Keyword data.",
        takes: null,
        docs: {
          href: "https://app.dataforseo.com/api-access",
          host: "app.dataforseo.com",
        },
        how: null,
        done: false,
      },
    ]);
    // What the admin could also set: the feature, with the Gateway setting it needs.
    expect(model.required).toEqual([]);
    expect(
      model.optional.map((feature) => [
        feature.name,
        feature.state,
        feature.gateway.map((row) => [row.label, row.done]),
      ]),
    ).toEqual([["Rendering", "off", [["Context.dev", false]]]]);
  });

  it("counts what is still unset, and says what one of the app's plain settings takes", () => {
    const model = setupDialogModel(
      setupOf(
        {
          id: "mc",
          settings: [
            {
              name: "POSTHOG_HOST",
              why: "Where the PostHog API is.",
              type: "url",
            },
            { name: "REGION", why: "Where data lives.", values: ["us", "eu"] },
          ],
        },
        [],
      ),
      { name: "Mission Control", canRun: true },
    );
    expect(model.gather).toBe("Have 2 settings ready");
    expect(model.always.map((row) => [row.label, row.takes])).toEqual([
      ["POSTHOG_HOST", "an http or https URL"],
      ["REGION", "us or eu"],
    ]);
  });

  it("names an app's own secret once", () => {
    const admin = setupDialogModel(setupOf(RESEARCH, ["OPENROUTER_API_KEY"]), {
      name: "Research Desk",
      canRun: true,
    });
    expect(admin.always.find((row) => !row.done)).toEqual({
      id: "MAIN_SECRET",
      label: "MAIN_SECRET",
      names: [],
      why: "Signs share links.",
      takes: null,
      docs: null,
      how: null,
      done: false,
    });
    expect(
      admin.optional.map((feature) => feature.values.map((row) => row.label)),
    ).toEqual([["WEBHOOK_SECRET"]]);
    // Only a Gateway setting keeps it closed: the optional app secret stays
    // under the fold.
    const gatewayOnly = setupDialogModel(setupOf(RESEARCH, ["MAIN_SECRET"]), {
      name: "Research Desk",
      canRun: true,
    });
    expect(gatewayOnly.always.map((row) => [row.label, row.done])).toEqual([
      ["OpenRouter", false],
      ["MAIN_SECRET", true],
    ]);
    expect(gatewayOnly.optional.map((feature) => feature.name)).toEqual([
      "Webhooks",
    ]);
  });

  it("tells a member to ask an admin, with nothing to get and no optional settings", () => {
    const model = setupDialogModel(setupOf(OPENSEO, ["OPENROUTER_API_KEY"]), {
      name: "OpenSEO",
      canRun: false,
    });
    expect(model.action).toEqual({
      kind: SetupAction.AskAdmin,
      command: "pnpm everyapp configure openseo",
    });
    expect(model.title).toBe("OpenSEO needs setup");
    expect(model.always.map((row) => [row.label, row.done])).toEqual([
      ["OpenRouter", true],
      ["DataForSEO", false],
    ]);
    // Where a key comes from is for whoever sets it.
    expect(model.always.every((row) => row.docs === null)).toBe(true);
    expect(model.optional).toEqual([]);
  });

  it("runs a provider app's own command, in the same steps", () => {
    const provider = setupDialogModel(
      {
        ...setupOf(OPENSEO, []),
        command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
      },
      { name: "DataForSEO", canRun: true },
    );
    expect(provider.action).toEqual({
      kind: SetupAction.Run,
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
    });
  });

  it("groups a feature's values under it: steps with URLs filled, how, state, and its Gateway settings", () => {
    const github: SettingsManifestLike & { id: string } = {
      id: "crm",
      secrets: [{ name: "MAIN_SECRET", why: "Signs share links." }],
      capabilities: { slack: { access: "write" } },
      features: {
        github: {
          name: "GitHub",
          required: true,
          why: "Links issues to deals.",
          steps: [
            "Make a GitHub App at [GitHub](https://github.com/settings/apps/new).",
            "Set its webhook URL to `{appUrl}/webhooks/github`.",
          ],
          secrets: [
            {
              name: "GITHUB_KEY",
              how: "The App's private key: {gatewayUrl}/x",
              file: true,
            },
          ],
          settings: [{ name: "GITHUB_OWNER" }],
        },
        slack: {
          name: "Slack",
          why: "Posts updates.",
          capabilities: ["slack"],
        },
      },
    };
    const model = setupDialogModel(setupOf(github, ["GITHUB_OWNER"]), {
      name: "OpenCRM",
      canRun: true,
    });
    // Top-level first; the required feature's values aren't repeated there.
    expect(model.always.map((row) => row.label)).toEqual(["MAIN_SECRET"]);
    const [feature] = model.required;
    expect(feature).toMatchObject({
      id: "github",
      name: "GitHub",
      required: true,
      state: "incomplete",
      why: "Links issues to deals.",
    });
    expect(feature!.steps).toEqual([
      [
        { kind: "text", text: "Make a GitHub App at " },
        {
          kind: "link",
          text: "GitHub",
          href: "https://github.com/settings/apps/new",
        },
        { kind: "text", text: "." },
      ],
      [
        { kind: "text", text: "Set its webhook URL to " },
        { kind: "code", text: "https://openseo.acme.com/webhooks/github" },
        { kind: "text", text: "." },
      ],
    ]);
    expect(
      feature!.values.map((row) => [row.label, row.done, row.how]),
    ).toEqual([
      [
        "GITHUB_KEY",
        false,
        [
          { kind: "text", text: "The App's private key: " },
          {
            kind: "link",
            text: "https://acme.com/x",
            href: "https://acme.com/x",
          },
        ],
      ],
      ["GITHUB_OWNER", true, null],
    ]);
    expect(model.optional.map((each) => [each.name, each.state])).toEqual([
      ["Slack", "off"],
    ]);
    // A member sees the required feature's values, but no steps, no how.
    const member = setupDialogModel(setupOf(github, []), {
      name: "OpenCRM",
      canRun: false,
    });
    expect(member.required[0]!.steps).toEqual([]);
    expect(member.required[0]!.values.every((row) => row.how === null)).toBe(
      true,
    );
    expect(member.optional).toEqual([]);
  });

  it("keeps an optional value no feature holds, from a manifest before features", () => {
    const model = setupDialogModel(
      setupOf(
        {
          id: "old",
          secrets: ["MAIN_SECRET", { name: "EXTRA", optional: true } as never],
        },
        [],
      ),
      { name: "Old", canRun: true },
    );
    expect(model.always.map((row) => row.label)).toEqual(["MAIN_SECRET"]);
    expect(
      model.optional.map((each) => [
        each.name,
        each.values.map((row) => row.label),
      ]),
    ).toEqual([["More settings", ["EXTRA"]]]);
  });

  it("says the platform is on it when nobody here can run the command", () => {
    const model = setupDialogModel(
      setupOf(OPENSEO, ["OPENROUTER_API_KEY"], false),
      { name: "OpenSEO", canRun: true },
    );
    expect(model.action).toEqual({ kind: SetupAction.Platform });
    expect(model.title).toBe("OpenSEO needs setup");
    expect(model.always.map((row) => row.label)).toEqual([
      "OpenRouter",
      "DataForSEO",
    ]);
    // Nothing for this reader to set, the optional settings included.
    expect(model.always.every((row) => row.docs === null)).toBe(true);
    expect(model.optional).toEqual([]);
  });
});

describe("inlineParts", () => {
  it("links http and https only, and leaves trailing punctuation outside a bare URL", () => {
    expect(
      inlineParts("See https://x.dev/a, then [b](javascript:alert(1)) **now**"),
    ).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://x.dev/a", href: "https://x.dev/a" },
      { kind: "text", text: ", then b) now" },
    ]);
  });
});
