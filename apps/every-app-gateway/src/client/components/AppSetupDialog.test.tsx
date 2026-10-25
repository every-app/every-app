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
  groups: [],
  command: { command: "pnpm everyapp configure openseo" },
};
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
  groups: [],
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

it("mounts with the unmet setting, its link, the command and the optional section", () => {
  const text = render(true);
  expect(text).toContain("OpenSEO needs setup");
  expect(text).toContain("Set these before anyone can open it.");
  expect(text).toContain("DataForSEO");
  expect(text).toContain("DATAFORSEO_API_KEY");
  expect(text).toContain("Keyword data.");
  expect(text).toContain("Get it at app.dataforseo.com/api-access");
  expect(text).toContain("pnpm everyapp configure openseo");
  // One line under the command: what it asks, then what follows.
  expect(text).toContain(
    "It asks for each setting above, then offers the optional ones. Run it in a terminal, then come back here: the app opens.",
  );
  expect(text).not.toContain("Ask an admin to run:");
  expect(text).toContain("Optional (1)");
  // Gateway settings are read live: nothing for `status` to re-read.
  expect(text).not.toContain("pnpm everyapp status");
  const link = document.body.querySelector<HTMLAnchorElement>(
    'a[href="https://app.dataforseo.com/api-access"]',
  );
  expect(link?.target).toBe("_blank");
  // One way to close, in the footer, like every other dialog.
  expect(closeButtons()).toHaveLength(1);
});

it("tells a member to ask an admin", () => {
  const text = render(false);
  expect(text).toContain("It opens once these are set.");
  expect(text).toContain("Ask an admin to run:");
  expect(text).toContain("pnpm everyapp configure openseo");
  expect(text).toContain("It asks for each setting above");
  expect(text).not.toContain("Run it in a terminal");
  expect(text).not.toContain("Optional (");
  expect(text).not.toContain("pnpm everyapp status");
});

it("names an app's own secret once and says status re-reads the Worker", () => {
  const text = render(true, SETUP_OWN_SECRET);
  expect(text.split("MAIN_SECRET").length - 1).toBe(1); // the row; the command names the app
  expect(text).toContain("pnpm everyapp configure research");
  expect(text).toContain("pnpm everyapp status");
});
