import { describe, expect, it } from "vitest";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { UserAccessApp } from "@/types/app";
import {
  appNeedsSetup,
  appStatus,
  appStatusLabel,
  AppStatusLabel,
  isMcpApp,
  isRemoteMcpApp,
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
  command: { command: "pnpm everyapp configure openseo" },
};

function app(
  overrides: Partial<
    Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier" | "paused">
  >,
) {
  return {
    hostname: "seo.apps.example.com",
    tier: "service_binding",
    status: "active",
    setup: null,
    paused: false,
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

describe("appStatus for a paused app", () => {
  it("shows Paused for a ready app at its monthly cap, and still opens it", () => {
    for (const setup of [READY, null]) {
      expect(appStatus(app({ setup, paused: true }))).toEqual({
        label: AppStatusLabel.Paused,
        variant: "warning",
        opens: true,
      });
      expect(appNeedsSetup(app({ setup, paused: true }))).toBe(false);
    }
  });

  it("lets setup and the deploy state win over a pause", () => {
    expect(appStatus(app({ setup: UNREADY, paused: true })).label).toBe(
      AppStatusLabel.NeedsSetup,
    );
    expect(appNeedsSetup(app({ setup: UNREADY, paused: true }))).toBe(true);
    expect(appStatus(app({ status: "disabled", paused: true })).label).toBe(
      AppStatusLabel.Disabled,
    );
    expect(appStatus(app({ hostname: null, paused: true })).label).toBe(
      AppStatusLabel.NeedsDeploy,
    );
  });

  it("shows Paused on an MCP app that is set up, which still never opens and still takes the agent dialog", () => {
    const mcp = { tier: PROVIDER_APP_TIER, hostname: null };
    expect(appStatus(app({ ...mcp, paused: true }))).toEqual({
      label: AppStatusLabel.Paused,
      variant: "warning",
      opens: false,
    });
    expect(mcpAppUsable(app({ ...mcp, paused: true }))).toBe(true);
    expect(appStatus(app({ ...mcp, setup: UNREADY, paused: true }))).toEqual({
      label: AppStatusLabel.NeedsSetup,
      variant: "warning",
      opens: false,
    });
    expect(mcpAppUsable(app({ ...mcp, setup: UNREADY, paused: true }))).toBe(
      false,
    );
    expect(appStatus(app({ ...mcp })).label).toBe(AppStatusLabel.Active);
  });

  it("reads an app that carries no pause (Admin → Apps) as before", () => {
    const { paused: _paused, ...withoutPause } = app({});
    expect(appStatus(withoutPause).label).toBe(AppStatusLabel.Active);
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

  it("needs setup while its key is unset, and is Off when turned off", () => {
    expect(appStatus(mcp({ setup: UNREADY }))).toEqual({
      label: AppStatusLabel.NeedsSetup,
      variant: "warning",
      opens: false,
    });
    expect(appNeedsSetup(mcp({ setup: UNREADY }))).toBe(true);
    expect(mcpAppUsable(mcp({ setup: UNREADY }))).toBe(false);
    for (const status of ["disabled", "deleted"]) {
      expect(appStatus(mcp({ status, setup: UNREADY }))).toEqual({
        label: AppStatusLabel.Off,
        variant: "secondary",
        opens: false,
      });
      expect(mcpAppUsable(mcp({ status }))).toBe(false);
      expect(appNeedsSetup(mcp({ status, setup: UNREADY }))).toBe(false);
    }
    // An app with a page that is disabled still reads Disabled.
    expect(appStatus(app({ status: "disabled" })).label).toBe(
      AppStatusLabel.Disabled,
    );
  });

  it("tells a remote MCP server from a built-in by its manifest, and reads one that wants OAuth as Not supported yet", () => {
    const remote = (kind: string) => ({
      ...mcp(),
      manifest: JSON.stringify({
        id: "treg",
        name: "Treg",
        description: "Treg's MCP server.",
        remote: {
          url: "https://treg.to/mcp/",
          auth:
            kind === "bearer" ? { kind, secret: "TREG_MCP_TOKEN" } : { kind },
          risk: "annotations",
          tools: {},
          rev: 1,
        },
      }),
    });
    expect(isRemoteMcpApp(remote("none"))).toBe(true);
    expect(isRemoteMcpApp(remote("bearer"))).toBe(true);
    expect(isRemoteMcpApp({ ...mcp(), manifest: '{"id":"dataforseo"}' })).toBe(
      false,
    );
    expect(isRemoteMcpApp(mcp())).toBe(false);
    expect(appStatus(remote("none")).label).toBe(AppStatusLabel.Active);
    expect(appStatus(remote("oauth"))).toEqual({
      label: AppStatusLabel.NotSupported,
      variant: "outline",
      opens: false,
    });
    expect(mcpAppUsable(remote("oauth"))).toBe(false);
  });
});
