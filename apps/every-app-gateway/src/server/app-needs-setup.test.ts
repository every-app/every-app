import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  env: { GATEWAY_URL: "https://gateway.example.com" } as Record<
    string,
    unknown
  >,
}));

vi.mock("cloudflare:workers", () => ({ env: hoisted.env }));

import { rowToRegisteredApp, type RegisteredApp } from "@every-app/perimeter";
import { resetAppSetupCacheForTests } from "./app-setup";
import {
  refuseUnreadyApp,
  resetNeedsSetupLogForTests,
} from "./app-needs-setup";

const OPENSEO = {
  id: "openseo",
  providers: ["openrouter"],
  secrets: ["MAIN_SECRET"],
};

function app(
  manifest: Record<string, unknown>,
  over: Partial<{
    tier: string;
    secretNames: string | null;
    versionId: string;
  }> = {},
): RegisteredApp {
  const id = String(manifest["id"]);
  return rowToRegisteredApp({
    appId: id,
    hostname: `${id}.example.com`,
    workerName: `every-acme-${id}`,
    tier: over.tier ?? "service_binding",
    scope: "org",
    organizationId: "org_1",
    status: "active",
    manifest: JSON.stringify(manifest),
    emailSenders: null,
    secretNames: over.secretNames === undefined ? null : over.secretNames,
    rowId: `row-${id}`,
    versionId: over.versionId ?? "v1",
  });
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://openseo.example.com${path}`, init);
}

const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

const refuse = (
  target: RegisteredApp,
  req: Request,
): Promise<Response | null> => refuseUnreadyApp({ app: target, request: req });

describe("refuseUnreadyApp", () => {
  beforeEach(() => {
    resetAppSetupCacheForTests();
    resetNeedsSetupLogForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete hoisted.env["OPENROUTER_API_KEY"];
    vi.restoreAllMocks();
  });

  it("sends a person opening the app to the launcher's setup dialog", async () => {
    const res = await refuse(app(OPENSEO), request("/", { headers: HTML }));

    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe(
      "https://gateway.example.com/?setup=openseo",
    );
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("strict-transport-security")).toContain("max-age");
  });

  it("redirects to the gateway's own origin only, with the app id encoded", async () => {
    // App ids are DNS labels in practice. This one isn't, to show that
    // whatever the registry holds, `?setup=` can't send anyone elsewhere:
    // the origin is the gateway's and the id is one query value.
    const appId = "todo/..?setup=x&next=https://evil.example#f";
    const res = await refuse(
      { ...app(OPENSEO), appId },
      request("/", { headers: HTML }),
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe(
      `https://gateway.example.com/?setup=${encodeURIComponent(appId)}`,
    );
    const location = new URL(res!.headers.get("location")!);
    expect(location.origin).toBe("https://gateway.example.com");
    expect(location.pathname).toBe("/");
    expect(location.hash).toBe("");
    expect([...location.searchParams]).toEqual([["setup", appId]]);
  });

  it("answers an API call with a 503 that names no setting", async () => {
    const res = await refuse(
      app(OPENSEO),
      request("/collect", { headers: { accept: "application/json" } }),
    );

    expect(res?.status).toBe(503);
    expect(res?.headers.get("retry-after")).toBeNull();
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("content-type")).toBe("application/json");
    const text = await res!.text();
    expect(JSON.parse(text)).toEqual({
      error: "app_needs_setup",
      app: "openseo",
    });
    expect(text).not.toContain("OPENROUTER");
    expect(text).not.toContain("MAIN_SECRET");
  });

  it("answers anything that isn't a page navigation with the 503", async () => {
    for (const req of [
      request("/api/audits", { headers: { accept: "application/json" } }),
      request("/", { headers: { ...HTML, "sec-fetch-mode": "cors" } }),
      request("/", { method: "POST", headers: HTML, body: "{}" }),
      request("/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        body: "{}",
      }),
    ]) {
      const res = await refuse(app(OPENSEO), req);
      expect(res?.status).toBe(503);
      await expect(res!.json()).resolves.toEqual({
        error: "app_needs_setup",
        app: "openseo",
      });
    }
  });

  it("opens an app whose settings are set, one that declares none, and a dispatch-tier one", async () => {
    hoisted.env["OPENROUTER_API_KEY"] = "sk-or";
    expect(
      await refuse(
        app(OPENSEO, { secretNames: '["MAIN_SECRET"]' }),
        request("/", { headers: HTML }),
      ),
    ).toBeNull();
    // Names never recorded are unknown, and unknown never blocks.
    expect(
      await refuse(
        app(OPENSEO, { versionId: "v2" }),
        request("/", { headers: HTML }),
      ),
    ).toBeNull();
    delete hoisted.env["OPENROUTER_API_KEY"];
    expect(
      await refuse(app({ id: "todo" }), request("/", { headers: HTML })),
    ).toBeNull();
    expect(
      await refuse(
        app(OPENSEO, { tier: "dispatch" }),
        request("/", { headers: HTML }),
      ),
    ).toBeNull();
  });

  it("closes the app when a recorded secret of its own is missing", async () => {
    hoisted.env["OPENROUTER_API_KEY"] = "sk-or";
    const res = await refuse(
      app(OPENSEO, { secretNames: "[]" }),
      request("/", { headers: HTML }),
    );
    expect(res?.status).toBe(302);
  });

  it("logs a refused app once per row and version, not per request", async () => {
    const log = vi.mocked(console.log);
    await refuse(app(OPENSEO), request("/", { headers: HTML }));
    await refuse(app(OPENSEO), request("/api", {}));
    await refuse(app(OPENSEO, { versionId: "v2" }), request("/", {}));

    const lines = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"evt":"app.needs_setup"'));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      evt: "app.needs_setup",
      app: "openseo",
      org: "org_1",
    });
  });
});
