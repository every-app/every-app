import { describe, it, expect, expectTypeOf, beforeAll, vi } from "vitest";
import {
  SignJWT,
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
} from "jose";
import {
  everyApp,
  getEveryAppUser,
  hasScope,
  isAdmin,
  requireCurrentUser,
  requireEveryAppUser,
  type EveryAppHandler,
  type EveryAppUser,
} from "./everyApp";
import { RequestContextError, currentUser } from "./context";
import {
  IDENTITY_ALG,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_KEY_ID,
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  PUBLIC_MARKER_SUB,
  AUDIENCE_ENV,
  DEV_ENV,
  DEV_ISSUER,
  ISSUER_ENV,
} from "../internal";

let privatePem: string;
let publicPem: string;
// The runtime hands everyApp() a real ExecutionContext; a stub stands in.
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const issuer = "https://home.example.com";

async function mint(
  aud = "every-todo",
  iss = issuer,
  kid = IDENTITY_KEY_ID,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const key = await importPKCS8(privatePem, IDENTITY_ALG);
  return new SignJWT({
    typ: "user",
    email: "a@b.com",
    org_id: "org_1",
    org_role: "member",
    chan: "web",
    act: { sub: "user_1" },
    jti: "j1",
    ...claims,
  })
    .setProtectedHeader({ alg: IDENTITY_ALG, kid })
    .setSubject("user_1")
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("120s")
    .sign(key);
}

async function mintPublicMarker(aud = "every-todo"): Promise<string> {
  const key = await importPKCS8(privatePem, IDENTITY_ALG);
  return new SignJWT({ typ: "public", pub: true })
    .setProtectedHeader({ alg: IDENTITY_ALG, kid: IDENTITY_KEY_ID })
    .setSubject(PUBLIC_MARKER_SUB)
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("120s")
    .sign(key);
}

beforeAll(async () => {
  const a = await generateKeyPair("RS256", { extractable: true });
  privatePem = await exportPKCS8(a.privateKey);
  publicPem = await exportSPKI(a.publicKey);
});

describe("everyApp", () => {
  // As everyAppWorker() deploys it: the audience is the Worker's name.
  const env = {
    [ISSUER_ENV]: issuer,
    [AUDIENCE_ENV]: "every-todo",
  } as Record<string, unknown>;

  it("passes the verified user to the handler", async () => {
    const app = everyApp(
      async (_req, _env, _ctx, user) =>
        new Response(JSON.stringify({ id: user?.id })),
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const token = await mint();
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: token },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("user_1");
  });

  it("hands the handler the runtime's ExecutionContext as the Worker got it", async () => {
    // What Hono's app.fetch(request, env, ctx) and React Router's load
    // context take: the runtime's ExecutionContext, with props.
    const honoFetch = (
      _request: Request,
      _env?: unknown,
      _executionCtx?: {
        waitUntil(promise: Promise<unknown>): void;
        passThroughOnException(): void;
        props: unknown;
      },
    ) => new Response("ok");
    let seen: ExecutionContext | undefined;
    const app = everyApp(
      async (request, handlerEnv, handlerCtx) => {
        seen = handlerCtx;
        return honoFetch(request, handlerEnv, handlerCtx);
      },
      { publicKeys: [publicPem] },
    );
    expectTypeOf<
      Parameters<typeof app.fetch>[2]
    >().toEqualTypeOf<ExecutionContext>();
    expectTypeOf<
      Parameters<EveryAppHandler>[2]
    >().toEqualTypeOf<ExecutionContext>();
    // A Worker with props narrows it.
    expectTypeOf<
      Parameters<
        EveryAppHandler<unknown, ExecutionContext<{ tenant: string }>>
      >[2]["props"]
    >().toEqualTypeOf<{ tenant: string }>();

    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint() },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(seen).toBe(ctx);
  });

  it("returns 401 when the identity token is missing", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      {
        id: "todo",
      },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("401s a publicAssets request that reaches the Worker, without running the handler", async () => {
    // The gateway forwards a `publicAssets` match with no identity and no
    // public marker. A file in the asset bundle is answered before the
    // Worker runs; any other path lands here and must not run app code.
    const handler = vi.fn(async () => new Response("app code"));
    const app = everyApp(handler, { publicKeys: [publicPem] });
    for (const method of ["GET", "HEAD"]) {
      const res = await app.fetch(
        new Request("https://todo.example.com/assets/not-a-file.js", {
          method,
          headers: { accept: "*/*", "user-agent": "curl/8" },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 on an audience mismatch", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      {
        id: "todo",
      },
      { publicKeys: [publicPem] },
    );
    const token = await mint("chef");
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: token },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("passes user=null for public routes (signed marker)", async () => {
    const app = everyApp(
      async (_req, _env, _ctx, user) =>
        new Response(JSON.stringify({ isNull: user === null })),
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/health", {
        headers: { [PUBLIC_HEADER]: await mintPublicMarker() },
      }),
      env,
      ctx,
    );
    expect(((await res.json()) as { isNull: boolean }).isNull).toBe(true);
  });

  it("401s a spoofed bare public header instead of running the handler", async () => {
    let handlerRan = false;
    const app = everyApp(
      async () => {
        handlerRan = true;
        return new Response("ok");
      },
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/anything", {
        headers: { [PUBLIC_HEADER]: "1" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(handlerRan).toBe(false);
  });

  it("supports the manifest-argument API", async () => {
    const app = everyApp(
      async (_req, _env, _ctx, user) => Response.json({ userId: user?.id }),
      { id: "todo", name: "Todos" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint() },
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ userId: "user_1" });
  });

  it("takes the audience from EVERYAPP_AUDIENCE, never the app id, outside dev", async () => {
    const app = everyApp(
      async (_req, _env, _ctx, user) => Response.json({ userId: user?.id }),
      { publicKeys: [publicPem] },
    );
    const request = (aud: string) =>
      mint(aud).then(
        (token) =>
          new Request("https://todo-acme.example.com/tasks", {
            headers: { [IDENTITY_HEADER]: token },
          }),
      );
    const appEnv = {
      [ISSUER_ENV]: issuer,
      EVERYAPP_APP_ID: "todo",
      [AUDIENCE_ENV]: "every-acme-todo",
    };

    const ok = await app.fetch(await request("every-acme-todo"), appEnv, ctx);
    expect(await ok.json()).toEqual({ userId: "user_1" });

    const appId = await app.fetch(await request("todo"), appEnv, ctx);
    expect(appId.status).toBe(401);
  });

  it("refuses a token minted for another Worker with the same app id", async () => {
    // Two organizations' copies of `todo`: a token the gateway minted for
    // one must never open the other.
    let handlerRan = false;
    const app = everyApp(
      async () => {
        handlerRan = true;
        return new Response("ok");
      },
      { publicKeys: [publicPem] },
    );
    const workerB = {
      [ISSUER_ENV]: issuer,
      EVERYAPP_APP_ID: "todo",
      [AUDIENCE_ENV]: "every-beta-todo",
    };

    const res = await app.fetch(
      new Request("https://todo-beta.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint("every-acme-todo") },
      }),
      workerB,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(handlerRan).toBe(false);

    const marker = await app.fetch(
      new Request("https://todo-beta.example.com/health", {
        headers: { [PUBLIC_HEADER]: await mintPublicMarker("every-acme-todo") },
      }),
      workerB,
      ctx,
    );
    expect(marker.status).toBe(401);
    expect(handlerRan).toBe(false);
  });

  it("returns 500 when EVERYAPP_AUDIENCE is unset outside dev", async () => {
    // The app id alone never stands in for the audience in a deployed
    // Worker, with or without a manifest naming it.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = everyApp(
      async () => new Response("ok"),
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint("todo") },
      }),
      { [ISSUER_ENV]: issuer, EVERYAPP_APP_ID: "todo" },
      ctx,
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "misconfigured",
      message: expect.stringContaining("EVERYAPP_AUDIENCE is not set"),
    });
  });

  it("falls back to the app id as the audience only under EVERYAPP_DEV", async () => {
    // `everyapp dev` mints for the app id and its Worker has no
    // EVERYAPP_AUDIENCE.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = everyApp(async () => new Response("ok"), {
      publicKeys: [publicPem],
    });
    const request = async () =>
      new Request("https://todo.localhost/tasks", {
        headers: {
          [IDENTITY_HEADER]: await mint(
            "todo",
            DEV_ISSUER,
            IDENTITY_DEV_KEY_ID,
          ),
        },
      });
    const devEnv = { [ISSUER_ENV]: DEV_ISSUER, EVERYAPP_APP_ID: "todo" };

    const dev = await app.fetch(
      await request(),
      { ...devEnv, [DEV_ENV]: "1" },
      ctx,
    );
    expect(dev.status).toBe(200);

    const deployed = await app.fetch(
      await request(),
      { ...devEnv, [DEV_ENV]: "0" },
      ctx,
    );
    spy.mockRestore();
    expect(deployed.status).toBe(500);
  });

  it("returns 500 when EVERYAPP_APP_ID contradicts the manifest", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let handlerRan = false;
    const app = everyApp(
      async () => {
        handlerRan = true;
        return new Response("ok");
      },
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://chef.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint("chef") },
      }),
      { ...env, EVERYAPP_APP_ID: "chef" },
      ctx,
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(handlerRan).toBe(false);
  });

  it("returns a resolved Promise from the WeakMap cache", async () => {
    const app = everyApp(
      async (request, handlerEnv) => {
        const user = await getEveryAppUser(request, handlerEnv);
        return Response.json({ userId: user?.id });
      },
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint() },
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ userId: "user_1" });
  });

  it("re-verifies a cloned request directly from env", async () => {
    const original = new Request("https://env-only.example.com/tasks", {
      headers: { [IDENTITY_HEADER]: await mint("every-env-only") },
    });
    const helperEnv = {
      EVERYAPP_APP_ID: "env-only",
      [AUDIENCE_ENV]: "every-env-only",
      EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
      [ISSUER_ENV]: issuer,
    };

    const user = await getEveryAppUser(new Request(original), helperEnv);

    expect(user?.id).toBe("user_1");
  });

  it("throws a 401 JSON Response from requireEveryAppUser for public requests", async () => {
    const app = everyApp(
      async (request, handlerEnv) => {
        try {
          await requireEveryAppUser(request, handlerEnv);
          return new Response("unexpected");
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
      },
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/health", {
        headers: { [PUBLIC_HEADER]: await mintPublicMarker() },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("returns 500 JSON for missing key configuration instead of 401", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = everyApp(async () => new Response("ok"), { id: "todo" });
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint() },
      }),
      env,
      ctx,
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
  });

  it("enforces the issuer from env when present", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      { id: "todo" },
      {
        publicKeys: [publicPem],
      },
    );
    const token = await mint("every-todo", "https://evil.example.com");
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: token },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns a clear 401 when the user identity issuer is not configured", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: await mint() },
      }),
      { [AUDIENCE_ENV]: "every-todo" },
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "unauthenticated",
      message: expect.stringContaining(
        "EVERYAPP_IDENTITY_ISSUER not configured",
      ),
    });
  });

  it("accepts env-driven dev identities only for EVERYAPP_DEV=1", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      { id: "todo" },
      { publicKeys: [publicPem] },
    );
    const token = await mint("every-todo", DEV_ISSUER, IDENTITY_DEV_KEY_ID);
    const request = () =>
      new Request("https://todo.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: token },
      });

    const disabled = await app.fetch(
      request(),
      {
        [ISSUER_ENV]: DEV_ISSUER,
        [AUDIENCE_ENV]: "every-todo",
        [DEV_ENV]: "0",
      },
      ctx,
    );
    expect(disabled.status).toBe(401);

    const enabled = await app.fetch(
      request(),
      {
        [ISSUER_ENV]: DEV_ISSUER,
        [AUDIENCE_ENV]: "every-todo",
        [DEV_ENV]: "1",
      },
      ctx,
    );
    expect(enabled.status).toBe(200);
  });

  it("preserves explicit allowDevIdentities: true opt-in", async () => {
    const app = everyApp(
      async () => new Response("ok"),
      { id: "todo" },
      { publicKeys: [publicPem], allowDevIdentities: true },
    );
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: {
          [IDENTITY_HEADER]: await mint(
            "todo",
            DEV_ISSUER,
            IDENTITY_DEV_KEY_ID,
          ),
        },
      }),
      { [ISSUER_ENV]: DEV_ISSUER, [DEV_ENV]: "0" },
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("answers 500 when EVERYAPP_DEV meets a real gateway's issuer", async () => {
    // A deployed Worker with EVERYAPP_DEV set would otherwise trust the
    // public dev keypair under its own issuer.
    const app = everyApp(async () => new Response("ok"), {
      publicKeys: [publicPem],
    });
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks", {
        headers: {
          [IDENTITY_HEADER]: await mint("todo", issuer, IDENTITY_DEV_KEY_ID),
        },
      }),
      { EVERYAPP_APP_ID: "todo", [ISSUER_ENV]: issuer, [DEV_ENV]: "1" },
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
  });
});

describe("hasScope", () => {
  const user: EveryAppUser = {
    id: "user_1",
    email: "a@b.com",
    orgId: "org_1",
    orgRole: "member",
    channel: "api",
    actor: { sub: "pat:token_1" },
    scopes: ["mcp:read"],
    jti: "j1",
  };

  it("matches exact scopes and wildcard scopes", () => {
    expect(hasScope(user, "mcp:read")).toBe(true);
    expect(hasScope(user, "mcp:write")).toBe(false);
    expect(hasScope({ ...user, scopes: ["*"] }, "mcp:write")).toBe(true);
  });
});

describe("the request context under everyApp()", () => {
  const env = {
    [ISSUER_ENV]: issuer,
    [AUDIENCE_ENV]: "every-todo",
  } as Record<string, unknown>;
  // Read after beforeAll made the keypair.
  const options = () => ({ publicKeys: [publicPem] });
  const withToken = (token: string, path = "/tasks") =>
    new Request(`https://todo.example.com${path}`, {
      headers: { [IDENTITY_HEADER]: token },
    });

  it("answers currentUser() anywhere below the handler, after awaits too", async () => {
    const app = everyApp(async (_req, _env, _ctx, user) => {
      expect(currentUser()).toBe(user);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const deep = await (async () => currentUser())();
      return Response.json({ id: deep?.id, same: deep === user });
    }, options());
    const res = await app.fetch(withToken(await mint()), env, ctx);
    expect(await res.json()).toEqual({ id: "user_1", same: true });
    // And nothing leaks out of the request.
    expect(() => currentUser()).toThrowError(RequestContextError);
  });

  it("gives requireCurrentUser() the user, or the 401 on a public route", async () => {
    const app = everyApp(async () => {
      try {
        return Response.json({ id: requireCurrentUser().id });
      } catch (thrown) {
        return thrown as Response;
      }
    }, options());
    const res = await app.fetch(withToken(await mint()), env, ctx);
    expect(await res.json()).toEqual({ id: "user_1" });
    const marker = await mintPublicMarker();
    const anonymous = await app.fetch(
      new Request("https://todo.example.com/public", {
        headers: { [PUBLIC_HEADER]: marker },
      }),
      env,
      ctx,
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "unauthenticated" });
    expect(() => requireCurrentUser()).toThrowError(RequestContextError);
  });

  it("lets getEveryAppUser() take the headers alone, answering from the context", async () => {
    let verified = 0;
    const app = everyApp(async (request, handlerEnv, _ctx, user) => {
      // A framework that hands out headers alone (TanStack's getRequest()
      // rebuilds the request): the same token, no second verification.
      const again = await getEveryAppUser(request.headers, handlerEnv);
      const rebuilt = await getEveryAppUser(
        new Request("https://elsewhere.invalid/", {
          headers: request.headers,
        }),
        handlerEnv,
      );
      return Response.json({
        same: again === user && rebuilt === user,
        id: again?.id,
      });
    }, options());
    const token = await mint();
    const res = await app.fetch(withToken(token), env, ctx);
    expect(await res.json()).toEqual({ same: true, id: "user_1" });
    // Headers outside any request still verify on their own.
    const headers = new Headers({ [IDENTITY_HEADER]: token });
    const user = await getEveryAppUser(headers, {
      ...env,
      EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
    });
    expect(user?.id).toBe("user_1");
    verified += 1;
    expect(verified).toBe(1);
  });

  it("drops Set-Cookie from the response and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = everyApp(
      async () =>
        new Response("ok", {
          status: 201,
          headers: [
            ["set-cookie", "session=abc; Path=/"],
            ["set-cookie", "theme=dark"],
            ["x-keep", "yes"],
          ],
        }),
      options(),
    );
    const res = await app.fetch(withToken(await mint()), env, ctx);
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("x-keep")).toBe("yes");
    expect(await res.text()).toBe("ok");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Set-Cookie"));
    warn.mockRestore();
  });
});

describe("the organization pin", () => {
  const envFor = (
    pin: string | undefined,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      [ISSUER_ENV]: issuer,
      [AUDIENCE_ENV]: "every-todo",
      ...(pin === undefined ? {} : { EVERY_APP_ORG_ID: pin }),
      ...extra,
    }) as Record<string, unknown>;
  const app = () =>
    everyApp(
      async (_req, _env, _ctx, user) => Response.json({ org: user?.orgId }),
      { publicKeys: [publicPem] },
    );
  const withToken = (token: string) =>
    new Request("https://todo.example.com/tasks", {
      headers: { [IDENTITY_HEADER]: token },
    });

  it("refuses an identity for another organization than the Worker's", async () => {
    const res = await app().fetch(
      withToken(await mint()),
      envFor("org_2"),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "unauthenticated",
      message: expect.stringMatching(
        /organization "org_1".*"org_2".*EVERY_APP_ORG_ID/,
      ),
    });
  });

  it("opens for the pinned organization, and for any with no pin (a shared app)", async () => {
    for (const pin of ["org_1", undefined]) {
      const res = await app().fetch(withToken(await mint()), envFor(pin), ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ org: "org_1" });
    }
  });

  it("holds for getEveryAppUser() and requireEveryAppUser() outside the wrapper too", async () => {
    const env = envFor("org_2", {
      EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicPem]),
    });
    const request = withToken(await mint());
    await expect(getEveryAppUser(request, env)).rejects.toThrow(
      /EVERY_APP_ORG_ID/,
    );
    await expect(requireEveryAppUser(request, env)).rejects.toBeInstanceOf(
      Response,
    );
  });

  it("is not enforced under the dev opt-in (mirror mode signs real organizations in)", async () => {
    const devApp = everyApp(
      async (_req, _env, _ctx, user) => Response.json({ org: user?.orgId }),
      { publicKeys: [publicPem], allowDevIdentities: true, issuer: DEV_ISSUER },
    );
    const token = await mint("every-todo", DEV_ISSUER, IDENTITY_DEV_KEY_ID);
    const res = await devApp.fetch(
      withToken(token),
      { [AUDIENCE_ENV]: "every-todo", EVERY_APP_ORG_ID: "dev-org" },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org: "org_1" });
  });
});

describe("roles", () => {
  const env = {
    [ISSUER_ENV]: issuer,
    [AUDIENCE_ENV]: "every-todo",
  } as Record<string, unknown>;
  it("reads owner and admin as managers, and anything else as a member", async () => {
    const app = everyApp(
      async (_req, _env, _ctx, user) =>
        Response.json({
          role: user?.orgRole,
          admin: user ? isAdmin(user) : null,
        }),
      { publicKeys: [publicPem] },
    );
    for (const [claim, role, admin] of [
      ["owner", "owner", true],
      ["admin", "admin", true],
      ["member", "member", false],
      ["billing", "member", false],
    ] as const) {
      const token = await mint("every-todo", issuer, IDENTITY_KEY_ID, {
        org_role: claim,
      });
      const res = await app.fetch(
        new Request("https://todo.example.com/", {
          headers: { [IDENTITY_HEADER]: token },
        }),
        env,
        ctx,
      );
      expect(await res.json(), claim).toEqual({ role, admin });
    }
  });
});
