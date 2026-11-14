/**
 * An app's icon from the Gateway's own address (app-icon.ts): what is
 * asked of the app and with what, what of its answer is passed on, and
 * who gets it. The app here is a fake fetcher that records each request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppFetcher,
  AuthenticatedSession,
  RegisteredApp,
} from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  APP_ICON_MAX_BYTES,
  APP_ICON_TIMEOUT_MS,
  serveAppIcon,
  type AppIconDeps,
} from "./app-icon";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0]);

const CRM: RegisteredApp = {
  appId: "crm",
  hostname: "crm.apps.example.com",
  workerName: "every-acme-crm",
  tier: "service_binding",
  scope: "org",
  organizationId: "org-1",
  status: "active",
  manifest: validateManifest({ id: "crm", icon: "/everyapp-icon.svg" }),
};

const ADA: AuthenticatedSession = {
  sub: "user-ada",
  email: "ada@example.com",
  orgId: "org-1",
  orgRole: "member",
  orgName: "Acme",
};

const svgFile = () =>
  new Response(SVG, { headers: { "content-type": "image/svg+xml" } });
const icoFile = () =>
  new Response(ICO, {
    headers: { "content-type": "image/vnd.microsoft.icon" },
  });
const missing = () => new Response("not found", { status: 404 });

/** The app: what each path answers, and every request it was sent. */
function appServing(files: Record<string, () => Response | Promise<Response>>) {
  const asked: Request[] = [];
  const fetcher: AppFetcher = {
    async fetch(request) {
      asked.push(request);
      const file = files[new URL(request.url).pathname];
      return file ? file() : missing();
    },
  };
  return {
    asked,
    fetcher,
    paths: () => asked.map((r) => new URL(r.url).pathname),
  };
}

function deps(
  fetcher: AppFetcher,
  overrides: Partial<AppIconDeps> & { app?: RegisteredApp | null } = {},
): AppIconDeps & {
  authenticator: {
    authenticate: ReturnType<typeof vi.fn>;
    hasAppAccess: ReturnType<typeof vi.fn>;
  };
} {
  const { app = CRM, ...rest } = overrides;
  return {
    env: {},
    authenticator: {
      authenticate: vi.fn(async () => ADA),
      hasAppAccess: vi.fn(async () => true),
    },
    resolveApp: async (hostname: string) =>
      hostname === app?.hostname ? app : null,
    fetcherFor: () => fetcher,
    ...rest,
  } as never;
}

function iconRequest(
  path = "/app-icon/crm.apps.example.com",
  init: RequestInit = {},
): Request {
  return new Request(`https://gateway.example.com${path}`, {
    ...init,
    headers: {
      cookie:
        "__Secure-better-auth.session_token=ada-session; CF_Authorization=access-jwt",
      "cf-access-jwt-assertion": "access-jwt",
      "sec-fetch-site": "same-origin",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /app-icon/<hostname>", () => {
  it("serves the icon the manifest names, inert and for this browser only", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const response = await serveAppIcon(iconRequest(), deps(app.fetcher));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SVG);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/svg+xml",
      "cache-control": "private, max-age=3600",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    });
    expect(app.paths()).toEqual(["/everyapp-icon.svg"]);
  });

  it("sends the app a bare GET: nothing the visitor's browser sent", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    await serveAppIcon(
      iconRequest(undefined, {
        headers: {
          "x-everyapp-identity": "forged",
          "x-everyapp-public": "forged",
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "Ada's browser",
        },
      }),
      deps(app.fetcher),
    );

    const [asked] = app.asked;
    expect(asked!.method).toBe("GET");
    expect(asked!.url).toBe("https://crm.apps.example.com/everyapp-icon.svg");
    expect(asked!.redirect).toBe("manual");
    expect(Object.fromEntries(asked!.headers)).toEqual({
      accept: "image/svg+xml, image/*",
    });
  });

  it("passes on the bytes and the type, and no header of the app's", async () => {
    const app = appServing({
      "/everyapp-icon.svg": () =>
        new Response(SVG, {
          headers: {
            "content-type": "IMAGE/SVG+XML; charset=utf-8",
            "set-cookie":
              "__Secure-better-auth.session_token=evil; Domain=example.com",
            "content-security-policy": "script-src *",
            "cache-control": "public, max-age=31536000, immutable",
            "access-control-allow-origin": "*",
            link: "</x.js>; rel=preload",
            refresh: "0; url=https://evil.example",
          },
        }),
    });
    const response = await serveAppIcon(iconRequest(), deps(app.fetcher));

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-security-policy",
      "content-type",
      "cross-origin-resource-policy",
      "x-content-type-options",
    ]);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
  });

  it("falls back to the favicon when the manifest's icon isn't an image file, then to no icon", async () => {
    const notAnIcon: Record<string, () => Response> = {
      "the app's code refusing a request with no identity": () =>
        Response.json({ error: "unauthenticated" }, { status: 401 }),
      "a single-page app's HTML": () =>
        new Response("<!doctype html><script>alert(1)</script>", {
          headers: { "content-type": "text/html" },
        }),
      "script named .svg": () =>
        new Response("alert(1)", {
          headers: { "content-type": "text/javascript" },
        }),
      "no content type": () => new Response(new TextEncoder().encode(SVG)),
      "a redirect": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/icon.svg" },
        }),
      "an empty file": () =>
        new Response("", { headers: { "content-type": "image/svg+xml" } }),
    };
    for (const [what, answer] of Object.entries(notAnIcon)) {
      const app = appServing({
        "/everyapp-icon.svg": answer,
        "/favicon.ico": icoFile,
      });
      const response = await serveAppIcon(iconRequest(), deps(app.fetcher));
      expect(response.status, what).toBe(200);
      expect(response.headers.get("content-type"), what).toBe(
        "image/vnd.microsoft.icon",
      );
      expect(new Uint8Array(await response.arrayBuffer()), what).toEqual(ICO);
      expect(app.paths(), what).toEqual(["/everyapp-icon.svg", "/favicon.ico"]);
    }

    const bare = appServing({});
    const none = await serveAppIcon(iconRequest(), deps(bare.fetcher));
    expect(none.status).toBe(404);
    await expect(none.json()).resolves.toEqual({ error: "no_icon" });
    // Asked again sooner than a found icon: the next deploy may add one.
    expect(none.headers.get("cache-control")).toBe("private, max-age=300");
    expect(bare.paths()).toEqual(["/everyapp-icon.svg", "/favicon.ico"]);
  });

  it("asks only for the favicon when the manifest names no icon, or a stored one that isn't an icon path", async () => {
    const stored = [
      undefined,
      "//evil.example/icon.svg",
      "/../secret.svg",
      "/icon.svg?as=admin",
      "/api/export",
      "/__everyapp/tools/list.svg",
      "https://evil.example/icon.svg",
      42,
    ];
    for (const icon of stored) {
      const app = appServing({ "/favicon.ico": icoFile });
      const response = await serveAppIcon(
        iconRequest(),
        deps(app.fetcher, {
          app: { ...CRM, manifest: { ...CRM.manifest, icon } as never },
        }),
      );
      expect(response.status, String(icon)).toBe(200);
      expect(
        app.asked.map((request) => request.url),
        String(icon),
      ).toEqual(["https://crm.apps.example.com/favicon.ico"]);
    }
  });

  it("takes nothing from the request but the hostname: no path, no query", async () => {
    const app = appServing({
      "/everyapp-icon.svg": svgFile,
      "/api/export": () =>
        new Response("secret", { headers: { "content-type": "image/png" } }),
    });
    const withQuery = await serveAppIcon(
      iconRequest(
        "/app-icon/crm.apps.example.com?path=/api/export&icon=/api/export",
      ),
      deps(app.fetcher),
    );
    expect(withQuery.status).toBe(200);
    expect(await withQuery.text()).toBe(SVG);
    expect(app.paths()).toEqual(["/everyapp-icon.svg"]);

    for (const path of [
      "/app-icon/crm.apps.example.com/api/export",
      "/app-icon/crm.apps.example.com%2Fapi%2Fexport",
      "/app-icon/crm.apps.example.com/",
      "/app-icon/crm.apps.example.com:8443",
      "/app-icon/crm.apps.example.com@evil.example",
      "/app-icon/",
      "/app-icon/localhost",
    ]) {
      const fresh = appServing({ "/everyapp-icon.svg": svgFile });
      const fixture = deps(fresh.fetcher);
      const response = await serveAppIcon(iconRequest(path), fixture);
      expect(response.status, path).toBe(404);
      expect(fresh.asked, path).toEqual([]);
      expect(fixture.authenticator.authenticate, path).not.toHaveBeenCalled();
    }
  });

  it("refuses a file over the size cap, declared or not", async () => {
    const declared = appServing({
      "/everyapp-icon.svg": () =>
        new Response("x", {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(APP_ICON_MAX_BYTES + 1),
          },
        }),
    });
    expect(
      (await serveAppIcon(iconRequest(), deps(declared.fetcher))).status,
    ).toBe(404);

    // An endless body that declares no length: read no further than the cap.
    let pulled = 0;
    const endless = appServing({
      "/everyapp-icon.svg": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
          }),
          { headers: { "content-type": "image/svg+xml" } },
        ),
    });
    const response = await serveAppIcon(iconRequest(), deps(endless.fetcher));
    expect(response.status).toBe(404);
    expect(pulled * 64 * 1024).toBeLessThanOrEqual(
      APP_ICON_MAX_BYTES + 2 * 64 * 1024,
    );

    const atTheCap = appServing({
      "/everyapp-icon.svg": () =>
        new Response(new Uint8Array(APP_ICON_MAX_BYTES), {
          headers: { "content-type": "image/png" },
        }),
    });
    const kept = await serveAppIcon(iconRequest(), deps(atTheCap.fetcher));
    expect(kept.status).toBe(200);
    expect((await kept.arrayBuffer()).byteLength).toBe(APP_ICON_MAX_BYTES);
  });

  it("stops waiting for an app that doesn't answer, or stalls mid-file", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const silent: AppFetcher = {
      fetch(request) {
        signals.push(request.signal);
        return new Promise<Response>(() => undefined);
      },
    };
    const pending = serveAppIcon(iconRequest(), deps(silent));
    // Two files (the icon, then the favicon), each given its own wait.
    await vi.advanceTimersByTimeAsync(APP_ICON_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(APP_ICON_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(404);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);

    const stalled = appServing({
      "/everyapp-icon.svg": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<svg"));
            },
          }),
          { headers: { "content-type": "image/svg+xml" } },
        ),
      "/favicon.ico": icoFile,
    });
    const second = serveAppIcon(iconRequest(), deps(stalled.fetcher));
    await vi.advanceTimersByTimeAsync(APP_ICON_TIMEOUT_MS);
    const favicon = await second;
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe(
      "image/vnd.microsoft.icon",
    );
  });

  it("answers no icon, never an error, when the app can't be reached or throws", async () => {
    const throwing: AppFetcher = {
      fetch: async () => {
        throw new Error("Worker threw exception");
      },
    };
    const thrown = await serveAppIcon(iconRequest(), deps(throwing));
    expect(thrown.status).toBe(404);

    // No fetcherFor: the real seam, on an env with no binding for the app.
    const unbound = await serveAppIcon(iconRequest(), {
      ...deps(throwing),
      fetcherFor: undefined,
    });
    expect(unbound.status).toBe(404);
    await expect(unbound.json()).resolves.toEqual({ error: "no_icon" });
  });

  it("reaches the app through its service binding, the one seam", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const response = await serveAppIcon(iconRequest(), {
      ...deps(app.fetcher),
      env: { "APP__every-acme-crm": app.fetcher },
      fetcherFor: undefined,
    });
    expect(response.status).toBe(200);
    expect(app.paths()).toEqual(["/everyapp-icon.svg"]);
  });
});

describe("who gets an app's icon", () => {
  it("needs the browser session: no session is a 401, and the app is never asked", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const fixture = deps(app.fetcher);
    fixture.authenticator.authenticate.mockResolvedValue(null);
    const response = await serveAppIcon(iconRequest(), fixture);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fixture.authenticator.hasAppAccess).not.toHaveBeenCalled();
    expect(app.asked).toEqual([]);
  });

  it("takes no token, a personal one included, before anything reads it", async () => {
    for (const authorization of ["Bearer epat_abc", "Bearer anything"]) {
      const app = appServing({ "/everyapp-icon.svg": svgFile });
      const fixture = deps(app.fetcher);
      const response = await serveAppIcon(
        iconRequest(undefined, { headers: { authorization } }),
        fixture,
      );
      expect(response.status).toBe(401);
      expect(fixture.authenticator.authenticate).not.toHaveBeenCalled();
      expect(app.asked).toEqual([]);
    }
  });

  it("answers an app the person can't open exactly as it answers no app at all", async () => {
    const unknown = await serveAppIcon(
      iconRequest("/app-icon/nothing.apps.example.com"),
      deps(appServing({}).fetcher),
    );

    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const fixture = deps(app.fetcher);
    fixture.authenticator.hasAppAccess.mockResolvedValue(false);
    const refused = await serveAppIcon(iconRequest(), fixture);

    expect(fixture.authenticator.hasAppAccess).toHaveBeenCalledWith(ADA, CRM);
    expect(app.asked).toEqual([]);
    for (const response of [unknown, refused]) {
      expect(response.status).toBe(404);
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-type": "application/json",
        "cache-control": "no-store",
      });
    }
    expect(await refused.text()).toBe(await unknown.text());
  });

  it("serves a person who opens the app through their membership in its organization", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const fixture = deps(app.fetcher);
    // What hasAppAccess answers for another of the person's organizations.
    fixture.authenticator.hasAppAccess.mockResolvedValue({
      ...ADA,
      orgId: "org-2",
    });
    expect((await serveAppIcon(iconRequest(), fixture)).status).toBe(200);
  });

  it("serves no icon for an app that isn't live, a third-party app, or a row it can't route", async () => {
    const rows: [string, Partial<AppIconDeps> & { app?: RegisteredApp }][] = [
      ["deploying", { app: { ...CRM, status: "binding" } }],
      ["disabled", { app: { ...CRM, status: "disabled" } }],
      ["dispatch tier", { app: { ...CRM, tier: "dispatch" } }],
      [
        "unroutable",
        {
          resolveApp: async () => {
            throw new Error("unknown tier");
          },
        },
      ],
    ];
    for (const [what, overrides] of rows) {
      const app = appServing({ "/everyapp-icon.svg": svgFile });
      const fixture = deps(app.fetcher, overrides);
      const response = await serveAppIcon(iconRequest(), fixture);
      expect(response.status, what).toBe(404);
      await expect(response.json(), what).resolves.toEqual({
        error: "not_found",
      });
      expect(fixture.authenticator.hasAppAccess, what).not.toHaveBeenCalled();
      expect(app.asked, what).toEqual([]);
    }
  });

  it("refuses a page on another origin, an app's included, before the session is read", async () => {
    for (const site of ["same-site", "cross-site"]) {
      const app = appServing({ "/everyapp-icon.svg": svgFile });
      const fixture = deps(app.fetcher);
      const response = await serveAppIcon(
        iconRequest(undefined, { headers: { "sec-fetch-site": site } }),
        fixture,
      );
      expect(response.status, site).toBe(404);
      expect(fixture.authenticator.authenticate, site).not.toHaveBeenCalled();
      expect(app.asked, site).toEqual([]);
    }
    // The address typed into the browser: served, and inert (the headers above).
    const typed = appServing({ "/everyapp-icon.svg": svgFile });
    const response = await serveAppIcon(
      iconRequest(undefined, { headers: { "sec-fetch-site": "none" } }),
      deps(typed.fetcher),
    );
    expect(response.status).toBe(200);
  });

  it("answers HEAD without a body, and no other method", async () => {
    const app = appServing({ "/everyapp-icon.svg": svgFile });
    const head = await serveAppIcon(
      iconRequest(undefined, { method: "HEAD" }),
      deps(app.fetcher),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/svg+xml");
    expect(await head.text()).toBe("");
    // The app is still asked with a GET.
    expect(app.asked.map((request) => request.method)).toEqual(["GET"]);

    for (const method of ["POST", "PUT", "DELETE"]) {
      const fixture = deps(app.fetcher);
      const response = await serveAppIcon(
        iconRequest(undefined, { method }),
        fixture,
      );
      expect(response.status).toBe(405);
      expect(fixture.authenticator.authenticate).not.toHaveBeenCalled();
    }
  });
});
