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
  command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
};
SETUP.unmet = [SETUP.settings[0]!];

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

function render(canRun: boolean) {
  act(() =>
    root.render(
      <AppSetupDialog
        name="OpenSEO"
        setup={SETUP}
        canRun={canRun}
        onClose={() => undefined}
      />,
    ),
  );
  // The dialog renders in a portal, so read the whole document.
  return document.body.textContent ?? "";
}

it("mounts with the unmet setting, its link, the command and the optional section", () => {
  const text = render(true);
  expect(text).toContain("OpenSEO needs setup");
  expect(text).toContain("DataForSEO");
  expect(text).toContain("Keyword data.");
  expect(text).toContain("Get it at app.dataforseo.com/api-access");
  expect(text).toContain("pnpm everyapp secret set DATAFORSEO_API_KEY");
  expect(text).not.toContain("Ask an admin to run:");
  expect(text).toContain("Optional (1)");
  expect(text).toContain("pnpm everyapp status");
  const link = document.body.querySelector<HTMLAnchorElement>(
    'a[href="https://app.dataforseo.com/api-access"]',
  );
  expect(link?.target).toBe("_blank");
});

it("tells a member to ask an admin", () => {
  const text = render(false);
  expect(text).toContain("Ask an admin to run:");
  expect(text).toContain("pnpm everyapp secret set DATAFORSEO_API_KEY");
  expect(text).not.toContain("Optional (");
});
