import { describe, it, expect, beforeAll } from "vitest";
import { importSPKI, jwtVerify } from "jose";
import { createDevGatewayHandler, DEV_USER } from "./devGateway";
import type { RegisteredApp } from "../registry";
import { validateManifest } from "../manifest/manifest";
import { generateTestKeyPair, type TestKeyPair } from "../test-helpers";
import { IDENTITY_HEADER } from "../headers";
import { IDENTITY_ALG } from "@every-app/sdk/internal";

let keys: TestKeyPair;
beforeAll(async () => {
  keys = await generateTestKeyPair();
});

function todoApp(): RegisteredApp {
  return {
    appId: "todo",
    hostname: "todo.localhost",
    workerName: "every-todo-app",
    tier: "service_binding",
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
    privateKeyPem: keys.privateKeyPem,
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

  it("mints a real identity JWT for the seeded dev user", async () => {
    const handler = handlerWithEcho();
    const res = await handler(
      new Request("http://todo.localhost:8787/tasks", {
        headers: { host: "todo.localhost:8787" },
      }),
    );
    const body = (await res.json()) as { identity: string };
    const pub = await importSPKI(keys.publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(body.identity, pub, {
      audience: "todo",
    });
    expect(payload.sub).toBe(DEV_USER.sub);
    expect(payload.org_role).toBe("owner");
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
});
