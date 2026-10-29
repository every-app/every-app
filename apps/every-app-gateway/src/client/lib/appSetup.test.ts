/**
 * The setup dialog's wording from an app's `setup`, built with the SDK's
 * own model so the dialog follows what the gateway evaluates.
 */
import { describe, expect, it } from "vitest";
import {
  appSettings,
  appSetupOf,
  evaluateAppSettings,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import { SetupAction, setupDialogModel } from "./appSetup";

const OPENSEO: SettingsManifestLike & { id: string } = {
  id: "openseo",
  providers: ["openrouter"],
  capabilities: {
    dataforseo: { access: "read", why: "Keyword data." },
    context: { access: "read", optional: true, why: "JS rendering in audits." },
  },
};

const INBOX: SettingsManifestLike & { id: string } = {
  id: "inbox",
  providers: [
    { id: "openrouter", anyOf: "AI model" },
    { id: "workers-ai", anyOf: "AI model" },
  ],
};

/** An app with a secret of its own, which the CLI records on its Worker. */
const RESEARCH: SettingsManifestLike & { id: string } = {
  id: "research",
  providers: ["openrouter"],
  secrets: [
    { name: "MAIN_SECRET", why: "Signs share links." },
    { name: "WEBHOOK_SECRET", optional: true },
  ],
};

/** The app's setup as the gateway lists it, with these names set. */
function setupOf(
  manifest: SettingsManifestLike & { id: string },
  set: readonly string[],
  withCommand = true,
) {
  const report = evaluateAppSettings(appSettings(manifest), (_holder, name) =>
    set.includes(name),
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
    expect(model.needed).toEqual([
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
        done: false,
      },
    ]);
    expect(model.anyOf).toEqual([]);
    // What the admin could also set, for the feature that uses it.
    expect(model.optional.map((row) => [row.label, row.why])).toEqual([
      ["Context.dev", "JS rendering in audits."],
    ]);
    expect(model.optionalSummary).toBe("Context.dev");
    // Every setting here is the Gateway's, read live: nothing to re-read.
    expect(model.statusHint).toBe(false);
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
    expect(model.needed.map((row) => [row.label, row.takes])).toEqual([
      ["POSTHOG_HOST", "an http or https URL"],
      ["REGION", "us or eu"],
    ]);
  });

  it("names an app's own secret once, and says status re-reads the Worker", () => {
    const admin = setupDialogModel(setupOf(RESEARCH, ["OPENROUTER_API_KEY"]), {
      name: "Research Desk",
      canRun: true,
    });
    expect(admin.needed.find((row) => !row.done)).toEqual({
      id: "MAIN_SECRET",
      label: "MAIN_SECRET",
      names: [],
      why: "Signs share links.",
      takes: null,
      docs: null,
      done: false,
    });
    expect(admin.optional.map((row) => row.label)).toEqual(["WEBHOOK_SECRET"]);
    expect(admin.statusHint).toBe(true);
    // A member can't run status: no hint.
    const member = setupDialogModel(setupOf(RESEARCH, ["OPENROUTER_API_KEY"]), {
      name: "Research Desk",
      canRun: false,
    });
    expect(member.statusHint).toBe(false);
    // Only a Gateway setting keeps it closed: the optional app secret under
    // the fold doesn't make the footer talk about the Worker.
    const gatewayOnly = setupDialogModel(setupOf(RESEARCH, ["MAIN_SECRET"]), {
      name: "Research Desk",
      canRun: true,
    });
    expect(gatewayOnly.needed.map((row) => [row.label, row.done])).toEqual([
      ["OpenRouter", false],
      ["MAIN_SECRET", true],
    ]);
    expect(gatewayOnly.optional.map((row) => row.label)).toEqual([
      "WEBHOOK_SECRET",
    ]);
    expect(gatewayOnly.statusHint).toBe(false);
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
    expect(model.needed.map((row) => [row.label, row.done])).toEqual([
      ["OpenRouter", true],
      ["DataForSEO", false],
    ]);
    // Where a key comes from is for whoever sets it.
    expect(model.needed.every((row) => row.docs === null)).toBe(true);
    expect(model.optional).toEqual([]);
  });

  it("says one member of an any-of group is enough, and counts the group once", () => {
    const none = setupDialogModel(setupOf(INBOX, []), {
      name: "Inbox",
      canRun: true,
    });
    expect(none.needed.map((row) => row.label)).toEqual([
      "OpenRouter",
      "Workers AI",
    ]);
    expect(none.gather).toBe("Get 1 key");
    expect(none.anyOf).toEqual([
      "One of these is enough: OpenRouter, Workers AI",
    ]);

    // A provider app's command sets its key by name, in the same steps.
    const provider = setupDialogModel(
      {
        ...setupOf(INBOX, []),
        command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
      },
      { name: "DataForSEO", canRun: true },
    );
    expect(provider.action).toEqual({
      kind: SetupAction.Run,
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
    });

    // One set meets the group: it is ticked off, and the other no longer
    // counts as needed.
    const one = setupDialogModel(setupOf(INBOX, ["OPENROUTER_API_KEY"]), {
      name: "Inbox",
      canRun: true,
    });
    expect(one.needed.map((row) => [row.label, row.done])).toEqual([
      ["OpenRouter", true],
    ]);
    expect(one.anyOf).toEqual([]);
  });

  it("names the first optional settings in the folded line", () => {
    const model = setupDialogModel(
      setupOf(
        {
          id: "crm",
          capabilities: {
            context: { access: "read" },
            "google-workspace": { access: "write", optional: true },
            "microsoft-365": { access: "write", optional: true },
            slack: { access: "write", optional: true },
          },
          secrets: [
            { name: "GITHUB_TOKEN", optional: true },
            { name: "ERASURE_SECRET", optional: true },
          ],
        },
        [],
      ),
      { name: "OpenCRM", canRun: true },
    );
    expect(model.optionalSummary).toBe("Google, Microsoft 365, Slack, +2 more");
  });

  it("says the platform is on it when nobody here can run the command", () => {
    const model = setupDialogModel(
      setupOf(OPENSEO, ["OPENROUTER_API_KEY"], false),
      { name: "OpenSEO", canRun: true },
    );
    expect(model.action).toEqual({ kind: SetupAction.Platform });
    expect(model.title).toBe("OpenSEO needs setup");
    expect(model.needed.map((row) => row.label)).toEqual([
      "OpenRouter",
      "DataForSEO",
    ]);
    // Nothing for this reader to set, the optional settings included.
    expect(model.needed.every((row) => row.docs === null)).toBe(true);
    expect(model.optional).toEqual([]);
    expect(model.statusHint).toBe(false);
  });
});
