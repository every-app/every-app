import { describe, it, expect } from "vitest";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import {
  createDevGatewayHandler,
  DEV_USER,
  mintDevIdentityJwt,
  mintDevPublicMarkerJwt,
} from "./devGateway";
import type { RegisteredApp } from "../registry";
import { validateManifest } from "../manifest/manifest";
import { IDENTITY_HEADER } from "../headers";
import {
  DEV_ISSUER,
  DEV_PUBLIC_KEY_PEM,
  IDENTITY_DEV_KEY_ID,
} from "@every-app/sdk/dev";
import { IDENTITY_ALG } from "@every-app/sdk/internal";

function todoApp(): RegisteredApp {
  return {
    appId: "todo",
    hostname: "todo.localhost",
    workerName: "every-todo-app",
    tier: "service_binding",
    scope: "org",
    organizationId: "dev-org",
    status: "active",
    manifest: validateManifest({ id: "todo", public: [{ path: "/health" }] }),
  };
}

function handlerWithEcho() {
  const echo = {
    fetch: async (req: Request) =>
      Response.json({
        identity: req.headers.get(IDENTITY_HEADER),
        public: req.headers.get("x-everyapp-public"),
      }),
  };
  return createDevGatewayHandler({
    apps: [todoApp()],
    env: {},
    fetcherFor: () => echo,
  });
}

describe("dev gateway-lite", () => {
  it("resolves the app from the first Host label (any base host)", async () => {
    const handler = handlerWithEcho();
    for (const base of ["localhost:8787", "fix-ui.everyapp.localhost"]) {
      const res = await handler(
        new Request(`http://todo.${base}/tasks`, {
          headers: { host: `todo.${base}` },
        }),
      );
      expect(res.status).toBe(200);
    }
  });

  it("mints a real identity JWT for the seeded dev user, with the SDK's dev key", async () => {
    const handler = handlerWithEcho();
    const res = await handler(
      new Request("http://todo.localhost:8787/tasks", {
        headers: { host: "todo.localhost:8787" },
      }),
    );
    const body = (await res.json()) as { identity: string };
    const pub = await importSPKI(DEV_PUBLIC_KEY_PEM, IDENTITY_ALG);
    const { payload } = await jwtVerify(body.identity, pub, {
      audience: "todo",
      issuer: DEV_ISSUER,
    });
    expect(decodeProtectedHeader(body.identity).kid).toBe(IDENTITY_DEV_KEY_ID);
    expect(payload.sub).toBe(DEV_USER.sub);
    expect(payload.org_role).toBe("owner");
  });

  it("mints upgrade identities and public markers with the same key and issuer", async () => {
    const pub = await importSPKI(DEV_PUBLIC_KEY_PEM, IDENTITY_ALG);
    for (const token of [
      await mintDevIdentityJwt("todo"),
      await mintDevPublicMarkerJwt("todo"),
    ]) {
      await expect(
        jwtVerify(token, pub, { audience: "todo", issuer: DEV_ISSUER }),
      ).resolves.toBeTruthy();
      expect(decodeProtectedHeader(token).kid).toBe(IDENTITY_DEV_KEY_ID);
    }
  });

  it("public routes are auth-optional: the seeded dev session gets identity, not the marker", async () => {
    const handler = handlerWithEcho();
    const res = await handler(
      new Request("http://todo.localhost:8787/health", {
        headers: { host: "todo.localhost:8787" },
      }),
    );
    const body = (await res.json()) as {
      identity: string | null;
      public: string | null;
    };
    expect(body.identity).toMatch(/^eyJ/);
    expect(body.public).toBeNull();
  });

  it("still enforces the real public-route policy locally (anonymous via x-everyapp-dev-anon)", async () => {
    const handler = handlerWithEcho();
    const res = await handler(
      new Request("http://todo.localhost:8787/health", {
        headers: { host: "todo.localhost:8787", "x-everyapp-dev-anon": "1" },
      }),
    );
    const body = (await res.json()) as {
      identity: string | null;
      public: string;
    };
    expect(body.public).toMatch(/^eyJ/); // signed public marker, not a bare flag
    expect(body.identity).toBeNull();

    // Anonymous on a PRIVATE route still 401s.
    const priv = await handler(
      new Request("http://todo.localhost:8787/tasks", {
        headers: { host: "todo.localhost:8787", "x-everyapp-dev-anon": "1" },
      }),
    );
    expect(priv.status).toBe(401);
  });

  it("404s for the base host (launcher), which has no app label", async () => {
    const handler = handlerWithEcho();
    const res = await handler(
      new Request("http://localhost:8787/", {
        headers: { host: "localhost:8787" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("hands /mcp to the local ToolBus with the dev session", async () => {
    const seen: unknown[] = [];
    const handler = createDevGatewayHandler({
      apps: [todoApp()],
      env: {},
      fetcherFor: () => ({ fetch: async () => new Response("app") }),
      interceptMcp: async ({ app, session }) => {
        seen.push([app.appId, session.sub]);
        return Response.json({ toolbus: true });
      },
    });
    const res = await handler(
      new Request("http://todo.localhost:8787/mcp", {
        method: "POST",
        headers: {
          host: "todo.localhost:8787",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }),
    );
    expect(await res.json()).toEqual({ toolbus: true });
    expect(seen).toEqual([["todo", DEV_USER.sub]]);
  });
});
