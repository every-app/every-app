import { describe, expect, it } from "vitest";
import type { UserAccessApp } from "@/types/app";
import { appNeedsSetup, appStatus, AppStatusLabel } from "./appStatus";

const READY: UserAccessApp["setup"] = {
  ready: true,
  settings: [],
  unmet: [],
  groups: [],
  command: null,
};
const UNREADY: UserAccessApp["setup"] = {
  ready: false,
  settings: [],
  unmet: [],
  groups: [],
  command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
};

function app(
  overrides: Partial<Pick<UserAccessApp, "hostname" | "status" | "setup">>,
) {
  return {
    hostname: "seo.apps.example.com",
    tier: "service_binding",
    status: "active",
    setup: null,
    ...overrides,
  };
}

describe("appStatus", () => {
  it("shows Needs setup for an active app whose settings aren't all set, and doesn't open it", () => {
    const status = appStatus(app({ setup: UNREADY }));
    expect(status).toEqual({
      label: AppStatusLabel.NeedsSetup,
      variant: "warning",
      opens: false,
    });
    expect(appNeedsSetup(app({ setup: UNREADY }))).toBe(true);
  });

  it("shows Active for an active app that is ready, or declares nothing", () => {
    for (const setup of [READY, null]) {
      expect(appStatus(app({ setup }))).toEqual({
        label: AppStatusLabel.Active,
        variant: "success",
        opens: true,
      });
      expect(appNeedsSetup(app({ setup }))).toBe(false);
    }
  });

  it("lets the deploy state come first: an app not deployed, deploying or disabled shows that, set up or not", () => {
    expect(appStatus(app({ hostname: null, setup: UNREADY })).label).toBe(
      AppStatusLabel.NeedsDeploy,
    );
    expect(appStatus(app({ status: "pending", setup: UNREADY })).label).toBe(
      AppStatusLabel.NeedsDeploy,
    );
    expect(appStatus(app({ status: "binding", setup: UNREADY })).label).toBe(
      AppStatusLabel.Deploying,
    );
    expect(appStatus(app({ status: "disabled", setup: UNREADY })).label).toBe(
      AppStatusLabel.Disabled,
    );
    expect(appNeedsSetup(app({ status: "disabled", setup: UNREADY }))).toBe(
      false,
    );
  });
});
