import { describe, expect, it } from "vitest";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { UserAccessApp } from "@/types/app";
import {
  appNeedsSetup,
  appStatus,
  appStatusLabel,
  AppStatusLabel,
  isMcpApp,
  mcpAppUsable,
} from "./appStatus";

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

describe("appStatusLabel", () => {
  it("says the same word as appStatus for a status alone", () => {
    for (const status of ["active", "binding", "pending", "disabled"]) {
      expect(appStatusLabel(status)).toBe(appStatus(app({ status })).label);
    }
    expect(appStatusLabel("binding")).toBe(AppStatusLabel.Deploying);
    expect(appStatusLabel("pending")).toBe(AppStatusLabel.NeedsDeploy);
    // A status this gateway doesn't know shows as it is, there too.
    expect(appStatusLabel("archived")).toBe("archived");
    expect(appStatus(app({ status: "archived" })).label).toBe("archived");
  });
});

describe("an MCP app", () => {
  function mcp(
    overrides: Partial<Pick<UserAccessApp, "status" | "setup">> = {},
  ) {
    return {
      hostname: null,
      tier: PROVIDER_APP_TIER,
      status: "active",
      setup: READY,
      ...overrides,
    };
  }

  it("is Active once its key is set, and still never opens: the dialog opens instead", () => {
    expect(appStatus(mcp())).toEqual({
      label: AppStatusLabel.Active,
      variant: "success",
      opens: false,
    });
    expect(isMcpApp(mcp())).toBe(true);
    expect(mcpAppUsable(mcp())).toBe(true);
    expect(appNeedsSetup(mcp())).toBe(false);
    // An app with a page is never an MCP app, however ready.
    expect(isMcpApp(app({}))).toBe(false);
    expect(mcpAppUsable(app({}))).toBe(false);
  });

  it("needs setup while its key is unset, and is Disabled when off", () => {
    expect(appStatus(mcp({ setup: UNREADY }))).toEqual({
      label: AppStatusLabel.NeedsSetup,
      variant: "warning",
      opens: false,
    });
    expect(appNeedsSetup(mcp({ setup: UNREADY }))).toBe(true);
    expect(mcpAppUsable(mcp({ setup: UNREADY }))).toBe(false);
    expect(appStatus(mcp({ status: "deleted" }))).toEqual({
      label: AppStatusLabel.Disabled,
      variant: "secondary",
      opens: false,
    });
    expect(mcpAppUsable(mcp({ status: "deleted" }))).toBe(false);
  });
});
