import { describe, expect, it } from "vitest";
import { listBuiltinTools } from "./builtins";
import { listTools } from "./server";
import { PRINCIPAL, todoApp } from "./test-fixtures";
import type { ToolBusApp, ToolBusTool } from "./types";
import {
  CLAUDE_CODE_INSTRUCTIONS_READ,
  FULL_LISTING_MAX_BYTES,
  FULL_LISTING_MAX_TOOLS,
  gatewayInstructionsHead,
  gatewaySurfaceView,
} from "./view";

const FULL_HEADER =
  "Tools for Acme on Every App. Each tool is named `<app>_<tool>`; call everyapp_list_apps to see what each app is for. everyapp_search_tools finds a tool by words.";

/** `count` read tools, `schemaBytes` of description inside each schema. */
function manyTools(count: number, schemaBytes = 0): ToolBusTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${String(index).padStart(3, "0")}`,
    description: `Tool ${index}.`,
    risk: "read" as const,
    inputSchema: {
      type: "object",
      properties: {},
      ...(schemaBytes ? { description: "x".repeat(schemaBytes) } : {}),
    },
  }));
}

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
      listing: "full",
      serverInfo: { name: "every-app", title: "Acme · Every App" },
      requestId: "ray_1",
    });
    expect(view.allowedOrigins).toBeUndefined();
    expect(view.instructions).toBe(
      [
        FULL_HEADER,
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
        FULL_HEADER,
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

    // The compact head is longer (it says how to find and run a tool), and
    // the worst case of that stays inside the read too.
    const compact = gatewayInstructionsHead(
      principal,
      apps,
      unavailable,
      "compact",
    );
    expect(compact.length).toBeGreaterThan(worst.length);
    expect(compact.length).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTIONS_READ);
    expect(
      gatewaySurfaceView(principal, apps, { unavailable, listing: "compact" })
        .instructions,
    ).toContain(compact);
  });

  describe("the listing mode", () => {
    const acme = { ...PRINCIPAL, organizationName: "Acme" };
    const appOf = (tools: ToolBusTool[], appId = "big"): ToolBusApp =>
      todoApp({ appId, rowId: `row_${appId}`, instructions: undefined, tools });

    it("is full while the full listing fits 256 tools, compact past that", () => {
      // Three built-ins are listed in full mode, so 253 app tools make a
      // listing of exactly 256 (full) and one more passes it (compact).
      const builtins = listBuiltinTools({ principal: acme, listing: "full" });
      expect(builtins).toHaveLength(3);
      const fits = gatewaySurfaceView(acme, [
        appOf(manyTools(FULL_LISTING_MAX_TOOLS - builtins.length)),
      ]);
      expect(fits.listing).toBe("full");
      expect(listTools(fits)).toHaveLength(FULL_LISTING_MAX_TOOLS);

      const past = gatewaySurfaceView(acme, [
        appOf(manyTools(FULL_LISTING_MAX_TOOLS - builtins.length + 1)),
      ]);
      expect(past.listing).toBe("compact");
      expect(listTools(past).map((tool) => tool.name)).toEqual([
        "everyapp_list_apps",
        "everyapp_whoami",
        "everyapp_search_tools",
        "everyapp_call_read",
        "everyapp_call_write",
      ]);
    });

    it("counts the tools the caller could see: hidden ones don't push it compact", () => {
      const tools = [
        ...manyTools(200),
        ...manyTools(100).map((tool, index) => ({
          ...tool,
          name: `write_${index}`,
          risk: "write" as const,
        })),
      ];
      // 300 tools in the catalog, 200 of them visible to a read-only caller.
      expect(
        gatewaySurfaceView({ ...acme, access: "read" }, [appOf(tools)]).listing,
      ).toBe("full");
      expect(gatewaySurfaceView(acme, [appOf(tools)]).listing).toBe("compact");
    });

    it("is compact once the full listing would serialize past 1 MiB", () => {
      // 60 tools with 18 KiB schemas: well under 256, over a mebibyte.
      const heavy = appOf(manyTools(60, 18 * 1024));
      const full = listTools(
        gatewaySurfaceView(acme, [heavy], { listing: "full" }),
      );
      expect(full.length).toBeLessThan(FULL_LISTING_MAX_TOOLS);
      expect(JSON.stringify(full).length).toBeGreaterThan(
        FULL_LISTING_MAX_BYTES,
      );
      expect(gatewaySurfaceView(acme, [heavy]).listing).toBe("compact");
      // Half as many fits.
      expect(
        gatewaySurfaceView(acme, [appOf(manyTools(30, 18 * 1024))]).listing,
      ).toBe("full");
    });

    it("is the caller's when they chose one, whatever the size", () => {
      const small = gatewaySurfaceView(acme, [todoApp()], {
        listing: "compact",
      });
      expect(small.listing).toBe("compact");
      expect(listTools(small).map((tool) => tool.name)).not.toContain(
        "todo_list_todos",
      );
      const large = gatewaySurfaceView(acme, [appOf(manyTools(300))], {
        listing: "full",
      });
      expect(large.listing).toBe("full");
      expect(listTools(large)).toHaveLength(303);
    });

    it("tells a compact caller how to find and run tools, with the count it could reach", () => {
      const view = gatewaySurfaceView(
        acme,
        [
          todoApp({
            appId: "todo",
            name: "Todos",
            instructions: "Todos first.",
          }),
          todoApp({ appId: "chef", name: "Chef", instructions: undefined }),
        ],
        {
          listing: "compact",
          unavailable: [{ appId: "crm", name: "CRM", reason: "needs setup" }],
        },
      );
      // Two visible tools per app (the destructive one is hidden).
      expect(view.instructions).toBe(
        [
          "Tools for Acme on Every App. This connection lists its 4 tools compactly: call everyapp_search_tools (words, an app id, or both) to find tools and their input schemas, then everyapp_call_read or everyapp_call_write with a tool's name and arguments. Call everyapp_list_apps to see what each app is for.",
          "Apps: chef (Chef), todo (Todos).",
          "crm (CRM) is not available: needs setup.",
          "",
          "todo: Todos first.",
        ].join("\n"),
      );
      // A read-only caller reaches one tool per app, and is sent to the
      // read wrapper alone: the write wrapper is hidden from it.
      const readOnly = gatewaySurfaceView(
        { ...acme, access: "read" },
        [todoApp()],
        { listing: "compact" },
      ).instructions!;
      expect(readOnly).toContain(
        "lists its 1 tools compactly: call everyapp_search_tools (words, an app id, or both) to find tools and their input schemas, then everyapp_call_read with a tool's name and arguments (this connection is read only). Call everyapp_list_apps",
      );
      expect(readOnly).not.toContain("everyapp_call_write");
    });
  });
});
