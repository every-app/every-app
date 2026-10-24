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
import { PLATFORM_NOTE, setupDialogModel } from "./appSetup";

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
  it("lists each unmet setting with its names, why and where to get it, then the one command", () => {
    const model = setupDialogModel(setupOf(OPENSEO, ["OPENROUTER_API_KEY"]), {
      name: "OpenSEO",
      canRun: true,
    });
    expect(model.title).toBe("OpenSEO needs setup");
    expect(model.intro).toBe("Set these before anyone can open it.");
    expect(model.unmet).toEqual([
      {
        id: "dataforseo",
        label: "DataForSEO",
        names: ["DATAFORSEO_API_KEY"],
        why: "Keyword data.",
        docs: {
          href: "https://app.dataforseo.com/api-access",
          label: "app.dataforseo.com/api-access",
        },
      },
    ]);
    expect(model.anyOf).toEqual([]);
    expect(model.command).toEqual({
      heading: null,
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
      note: null,
    });
    expect(model.platformNote).toBeNull();
    // What the admin could also set, for the feature that uses it.
    expect(model.optional.map((row) => [row.label, row.why])).toEqual([
      ["Context.dev", "JS rendering in audits."],
    ]);
  });

  it("tells a member to ask an admin, and keeps the optional settings for whoever can set them", () => {
    const model = setupDialogModel(setupOf(OPENSEO, ["OPENROUTER_API_KEY"]), {
      name: "OpenSEO",
      canRun: false,
    });
    expect(model.unmet.map((row) => row.label)).toEqual(["DataForSEO"]);
    expect(model.command).toEqual({
      heading: "Ask an admin to run:",
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
      note: null,
    });
    expect(model.optional).toEqual([]);
  });

  it("says one member of an any-of group is enough, and carries the command's note", () => {
    const none = setupDialogModel(setupOf(INBOX, []), {
      name: "Inbox",
      canRun: true,
    });
    expect(none.unmet.map((row) => row.label)).toEqual([
      "OpenRouter",
      "Workers AI",
    ]);
    expect(none.anyOf).toEqual([
      "One of these is enough: OpenRouter, Workers AI",
    ]);
    expect(none.command).toMatchObject({
      command: "pnpm everyapp secret set OPENROUTER_API_KEY",
      note: expect.stringContaining("one AI model is enough"),
    });

    // One set: the other is something the admin could still set.
    const one = setupDialogModel(setupOf(INBOX, ["OPENROUTER_API_KEY"]), {
      name: "Inbox",
      canRun: true,
    });
    expect(one.unmet).toEqual([]);
    expect(one.anyOf).toEqual([]);
    expect(one.command).toBeNull();
    expect(one.optional.map((row) => row.label)).toEqual(["Workers AI"]);
  });

  it("says the platform is on it when nobody here can run the command", () => {
    const model = setupDialogModel(
      setupOf(OPENSEO, ["OPENROUTER_API_KEY"], false),
      { name: "OpenSEO", canRun: true },
    );
    expect(model.unmet.map((row) => row.label)).toEqual(["DataForSEO"]);
    expect(model.command).toBeNull();
    expect(model.platformNote).toBe(PLATFORM_NOTE);
  });

  it("leaves out the optional settings too for a shared app of another organization", () => {
    // How Admin → Apps and the launcher show a read-only shared app: the
    // platform sets its settings, the optional ones included, so the
    // reader sees what keeps it closed and who is on it, nothing to do.
    const model = setupDialogModel(
      setupOf(OPENSEO, ["OPENROUTER_API_KEY"], false),
      { name: "OpenSEO", canRun: false },
    );
    expect(model.unmet.map((row) => row.label)).toEqual(["DataForSEO"]);
    expect(model.command).toBeNull();
    expect(model.platformNote).toBe(PLATFORM_NOTE);
    expect(model.optional).toEqual([]);
  });
});
