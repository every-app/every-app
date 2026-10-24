import { describe, expect, it } from "vitest";
import { PRINCIPAL, todoApp } from "./test-fixtures";
import {
  CLAUDE_CODE_INSTRUCTIONS_READ,
  gatewayInstructionsHead,
  gatewaySurfaceView,
} from "./view";

describe("gatewaySurfaceView", () => {
  it("names the organization and lists the apps in its instructions", () => {
    const view = gatewaySurfaceView(
      { ...PRINCIPAL, organizationName: "Acme" },
      [
        todoApp({ appId: "todo", name: "Todos", instructions: "Todos first." }),
        todoApp({ appId: "chef", name: "Chef", instructions: undefined }),
      ],
      { requestId: "ray_1", allowedOrigins: [] },
    );

    expect(view).toMatchObject({
      surface: "gateway",
      serverInfo: { name: "every-app", title: "Acme · Every App" },
      requestId: "ray_1",
    });
    expect(view.allowedOrigins).toBeUndefined();
    expect(view.instructions).toBe(
      [
        "Tools for Acme on Every App. Each tool is named `<app>_<tool>`; call everyapp_list_apps to see what each app is for.",
        "Apps: chef (Chef), todo (Todos).",
        "",
        "todo: Todos first.",
      ].join("\n"),
    );
  });

  it("keeps many apps' instructions to a bounded size", () => {
    const apps = Array.from({ length: 40 }, (_, index) =>
      todoApp({
        appId: `app-${String(index).padStart(2, "0")}`,
        instructions: "x".repeat(5_000),
      }),
    );
    const { instructions } = gatewaySurfaceView(PRINCIPAL, apps);

    expect(instructions!.length).toBeLessThanOrEqual(8 * 1024);
    // The cap drops per-app blocks, never the head: the whole app list is
    // there even when most of the guidance is not.
    expect(
      instructions!.startsWith(gatewayInstructionsHead(PRINCIPAL, apps, [])),
    ).toBe(true);
    expect(instructions).toContain("app-00: " + "x".repeat(1023) + "…");
    expect(instructions).toContain("Apps: app-00 (Todos), app-01 (Todos)");
  });

  it("says so when no app is available yet", () => {
    expect(gatewaySurfaceView(PRINCIPAL, []).instructions).toContain(
      "No apps are available to this connection yet.",
    );
  });

  it("names each app that needs setup with why, and keeps it out of the apps", () => {
    const view = gatewaySurfaceView(
      { ...PRINCIPAL, organizationName: "Acme" },
      [todoApp({ appId: "todo", name: "Todos", instructions: undefined })],
      {
        unavailable: [
          {
            appId: "openseo",
            name: "OpenSEO",
            reason:
              "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY",
          },
          {
            appId: "crm",
            name: "CRM",
            reason: "needs setup",
          },
        ],
      },
    );

    expect(view.apps.map((app) => app.appId)).toEqual(["todo"]);
    expect(view.unavailable?.map((app) => app.appId)).toEqual([
      "openseo",
      "crm",
    ]);
    expect(view.instructions).toBe(
      [
        "Tools for Acme on Every App. Each tool is named `<app>_<tool>`; call everyapp_list_apps to see what each app is for.",
        "Apps: todo (Todos).",
        "crm (CRM) is not available: needs setup.",
        "openseo (OpenSEO) is not available: needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY.",
      ].join("\n"),
    );
    // No entry, no field: the app surface and a ready gateway read as before.
    expect(
      gatewaySurfaceView(PRINCIPAL, [], { unavailable: [] }),
    ).not.toHaveProperty("unavailable");
  });

  it("keeps the header, app list and not-available lines inside Claude Code's read for the launch apps", () => {
    // The launch set, each with the most guidance the catalog keeps (2048),
    // and the organization's real name.
    const principal = { ...PRINCIPAL, organizationName: "Every App Team" };
    const launch = [
      { appId: "agentic-inbox", name: "agentic-inbox" },
      { appId: "analytics", name: "OpenAnalytics" },
      { appId: "crm", name: "Open CRM" },
      { appId: "openseo", name: "OpenSEO" },
      { appId: "dataforseo", name: "DataForSEO" },
    ];
    const apps = launch.map((app) =>
      todoApp({ ...app, instructions: "x".repeat(2048) }),
    );

    const { instructions } = gatewaySurfaceView(principal, apps);
    const head = gatewayInstructionsHead(principal, apps, []);
    expect(instructions!.startsWith(head)).toBe(true);
    expect(head.length).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTIONS_READ);
    // The first app's guidance begins right after the head, so a client that
    // reads 4,096 characters holds the whole app list before any guidance.
    expect(instructions!.slice(head.length)).toMatch(
      /^\n\nagentic-inbox: x{1023}…\n\nanalytics: /,
    );

    // The worst case: every launch app needs setup, each with the longest
    // reason the gateway writes (needsSetupReason in gateway-mcp.ts: the
    // command, every name, --app, and an any-of note). The gateway puts an
    // app in the list or among the unavailable, never both, so a head with
    // all five in both is longer than any it produces.
    const unavailable = launch.map((app) => ({
      ...app,
      reason: `needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY MAIN_SECRET --app ${app.appId} (WORKERS_AI_API_TOKEN instead of OPENROUTER_API_KEY is fine too: one AI model is enough)`,
    }));
    for (const app of unavailable) {
      expect(app.reason.length).toBeGreaterThanOrEqual(150);
    }
    const worst = gatewayInstructionsHead(principal, apps, unavailable);
    expect(
      gatewaySurfaceView(principal, apps, { unavailable }).instructions,
    ).toContain(worst);
    expect(worst.length).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTIONS_READ);
  });
});
