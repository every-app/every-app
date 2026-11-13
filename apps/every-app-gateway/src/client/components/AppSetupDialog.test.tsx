// @vitest-environment happy-dom
/**
 * The setup dialog rendered for real (React in a DOM): it mounts, and
 * says what the model says. The wording itself is tested on the model
 * (lib/appSetup.test.ts).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AppSetup } from "@every-app/sdk/internal";
import { AppSetupDialog } from "./AppSetupDialog";

const SETUP: AppSetup = {
  ready: false,
  settings: [
    {
      kind: "capability",
      id: "dataforseo",
      label: "DataForSEO",
      holder: "gateway",
      names: ["DATAFORSEO_API_KEY"],
      need: { kind: "required" },
      why: "Keyword data.",
      docs: "https://app.dataforseo.com/api-access",
      set: false,
      blocking: true,
    },
    {
      kind: "capability",
      id: "context",
      label: "Context.dev",
      holder: "gateway",
      names: ["CONTEXT_API_KEY"],
      need: { kind: "optional" },
      why: "JS rendering in audits.",
      set: false,
      blocking: false,
    },
  ],
  unmet: [],
  features: [
    {
      id: "rendering",
      name: "Rendering",
      required: false,
      why: "Audits of JS sites.",
      steps: ["Get a key at https://context.dev, then come back to {appUrl}."],
      capabilities: ["context"],
      providers: [],
      state: "off",
      settings: ["context"],
    },
  ],
  command: { command: "pnpm everyapp configure openseo" },
};
SETUP.settings[1]!.feature = "rendering";
SETUP.unmet = [SETUP.settings[0]!];

/** An app whose own secret is unset: the Worker's, which `status` re-reads. */
const SETUP_OWN_SECRET: AppSetup = {
  ready: false,
  settings: [
    {
      kind: "secret",
      id: "MAIN_SECRET",
      label: "MAIN_SECRET",
      holder: "app",
      names: ["MAIN_SECRET"],
      need: { kind: "required" },
      why: "Signs share links.",
      set: false,
      blocking: true,
    },
  ],
  unmet: [],
  features: [],
  command: { command: "pnpm everyapp configure research" },
};
SETUP_OWN_SECRET.unmet = [SETUP_OWN_SECRET.settings[0]!];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(canRun: boolean, setup: AppSetup = SETUP) {
  act(() =>
    root.render(
      <AppSetupDialog
        name="OpenSEO"
        hostname="openseo.acme.com"
        setup={setup}
        canRun={canRun}
        onClose={() => undefined}
      />,
    ),
  );
  // The dialog renders in a portal, so read the whole document.
  return document.body.textContent ?? "";
}

function closeButtons() {
  return [...document.body.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === "Close",
  );
}

it("gives an admin the steps: the unmet setting and its link, the command, and the optional section", () => {
  const text = render(true);
  expect(text).toContain("Set up OpenSEO");
  expect(text).toContain("Get 1 key");
  expect(text).toContain("DataForSEO");
  expect(text).toContain("DATAFORSEO_API_KEY");
  expect(text).toContain("Keyword data.");
  expect(text).toContain("Run this in a terminal");
  expect(text).toContain("pnpm everyapp configure openseo");
  expect(text).not.toContain("Ask an admin to run:");
  // The optional feature, folded while off, with "Set up" to open it.
  expect(text).toContain("Optional");
  expect(text).toContain("Rendering");
  expect(text).toContain("Set up");
  expect(text).not.toContain("Audits of JS sites.");
  const link = document.body.querySelector<HTMLAnchorElement>(
    'a[href="https://app.dataforseo.com/api-access"]',
  );
  expect(link?.textContent).toContain("Get key");
  expect(link?.target).toBe("_blank");
  // One way to close, in the footer, like every other dialog.
  expect(closeButtons()).toHaveLength(1);
});

it("ticks off a setting that is already set", () => {
  // DataForSEO set, the app's own secret still to go.
  const dataforseo = { ...SETUP.settings[0]!, set: true, blocking: false };
  const text = render(true, {
    ...SETUP_OWN_SECRET,
    settings: [dataforseo, ...SETUP_OWN_SECRET.settings],
  });
  expect(text).toContain("DataForSEOSet");
  // A set row says nothing more about getting it.
  expect(text).not.toContain("Keyword data.");
  expect(
    document.body.querySelector(
      'a[href="https://app.dataforseo.com/api-access"]',
    ),
  ).toBeNull();
});

it("tells a member to ask an admin", () => {
  const text = render(false);
  expect(text).toContain("OpenSEO needs setup");
  expect(text).toContain("DataForSEO");
  expect(text).toContain("Ask an admin to run:");
  expect(text).toContain("pnpm everyapp configure openseo");
  expect(text).not.toContain("Run this in a terminal");
  expect(text).not.toContain("Rendering");
  expect(document.body.querySelector("a")).toBeNull();
});

it("names an app's own secret once", () => {
  const text = render(true, SETUP_OWN_SECRET);
  expect(text.split("MAIN_SECRET").length - 1).toBe(1); // the row; the command names the app
  expect(text).toContain("pnpm everyapp configure research");
});

it("shows a required feature open: steps with links and URLs filled, values, and the Gateway setting with Providers", () => {
  const text = render(true, {
    ...SETUP,
    settings: [
      ...SETUP.settings,
      {
        kind: "secret",
        id: "GITHUB_KEY",
        label: "GITHUB_KEY",
        holder: "app",
        names: ["GITHUB_KEY"],
        need: { kind: "required" },
        feature: "github",
        how: "Under {gatewayUrl}/x.",
        set: false,
        blocking: true,
      },
      {
        kind: "capability",
        id: "slack",
        label: "Slack",
        holder: "gateway",
        names: ["SLACK_CLIENT_ID"],
        need: { kind: "required" },
        feature: "github",
        set: false,
        blocking: true,
      },
    ],
    features: [
      ...SETUP.features,
      {
        id: "github",
        name: "GitHub",
        required: true,
        why: "Links issues to deals.",
        steps: ["Open [GitHub](https://github.com/settings/apps/new)."],
        capabilities: ["slack"],
        providers: [],
        state: "off",
        settings: ["GITHUB_KEY", "slack"],
      },
    ],
  });
  expect(text).toContain("Required");
  expect(text).toContain("GitHub");
  expect(text).toContain("Links issues to deals.");
  expect(text).toContain("Not set on the Gateway");
  const step = document.body.querySelector<HTMLAnchorElement>(
    'a[href="https://github.com/settings/apps/new"]',
  );
  expect(step?.textContent).toBe("GitHub");
  expect(step?.target).toBe("_blank");
  expect(text).toContain(`Under ${window.location.origin}/x`);
  expect(
    document.body.querySelector('a[href="/admin/providers"]')?.textContent,
  ).toContain("Providers");
});
