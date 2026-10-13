import { describe, expect, it } from "vitest";
import { PRINCIPAL, todoApp } from "./test-fixtures";
import { gatewaySurfaceView } from "./view";

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
    expect(instructions).toContain("app-00: " + "x".repeat(1023) + "…");
    expect(instructions).toContain("Apps: app-00 (Todos), app-01 (Todos)");
  });

  it("says so when no app is available yet", () => {
    expect(gatewaySurfaceView(PRINCIPAL, []).instructions).toContain(
      "No apps are available to this connection yet.",
    );
  });
});
