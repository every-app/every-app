import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allRowsGreen,
  taintFromGitStatus,
  detectShortcut,
  detectTaint,
  phaseReachedFrom,
  rowStatuses,
  statusView,
  verify,
  VERIFIER_VERSION,
  writeVerifyEvidence,
  type VerifyContext,
  type VerifyDeps,
} from "./verify";
import type { FetchLike, NormalizedEvent, StatusRunner } from "./types";

const zone = "everyapp-loop1.com";
const origin = `https://apps.${zone}`;
const appHost = `hello.apps.${zone}`;
const owner = {
  name: "Loop Owner",
  email: `owner@${zone}`,
  password: "pw-not-real-0123456789",
};
const COOKIE = "better-auth.session_token=abc; Path=/; HttpOnly";

type Route = (init: RequestInit) => Response | Error;

/** A fake gateway and app host as the verifier sees them from outside, healthy by default. */
function healthyRoutes(): Record<string, Route> {
  return {
    [`GET ${origin}/sign-in`]: () =>
      new Response("<html>sign in</html>", { status: 200 }),
    [`POST ${origin}/api/setup/claim`]: (init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      return headers["origin"]
        ? new Response('{"error":"INVALID_INPUT"}', { status: 400 })
        : new Response('{"error":"ORIGIN_NOT_ALLOWED"}', { status: 403 });
    },
    [`GET ${origin}/api/me/apps`]: () =>
      new Response('{"error":"unauthenticated"}', { status: 401 }),
    [`GET https://nope-cafe0000.apps.${zone}/`]: () =>
      new Response('{"error":"unknown_app_host"}', { status: 404 }),
    [`POST ${origin}/api/auth/sign-in/email`]: (init) => {
      const body = JSON.parse(String(init.body)) as {
        email: string;
        password: string;
      };
      if (body.email === owner.email && body.password === owner.password) {
        return new Response('{"token":"x"}', {
          status: 200,
          headers: { "set-cookie": COOKIE },
        });
      }
      return new Response('{"message":"Invalid email or password"}', {
        status: 401,
      });
    },
    [`GET ${origin}/api/auth/get-session`]: (init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      return headers["cookie"]?.includes("better-auth.session_token=abc")
        ? new Response(JSON.stringify({ user: { email: owner.email } }), {
            status: 200,
          })
        : new Response("null", { status: 200 });
    },
    [`GET https://${appHost}/`]: (init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (headers["cookie"])
        return new Response("<html>Simple Todo</html>", { status: 200 });
      if (headers["accept"] === "text/html")
        return new Response("", {
          status: 302,
          headers: {
            location: `${origin}/sign-in?return_to=https%3A%2F%2F${appHost}%2F`,
          },
        });
      return new Response('{"error":"unauthenticated"}', { status: 401 });
    },
  };
}

function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new TypeError(`fetch failed: no route for ${key}`);
    const answer = route(init);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls };
}

function healthyStatus(overrides: Record<string, unknown> = {}): StatusRunner {
  return async () => ({
    exitCode: 0,
    events: [],
    data: {
      claimed: true,
      owner: { email: owner.email },
      upToDate: true,
      apps: [{ id: "hello", status: "active", bound: true, hostname: appHost }],
      fixes: [{ code: "CHECKOUT_BEHIND", severity: "info" }],
      ...overrides,
    },
  });
}

const baseCtx = (overrides: Partial<VerifyContext> = {}): VerifyContext => ({
  zone,
  gatewayOrigin: origin,
  appHost,
  owner,
  claimHow: "event-log",
  diff: [
    { kind: "added", path: "/work/every-app/apps/hello/src/index.ts" },
    {
      kind: "changed",
      path: "/work/every-app/packages/cli/node_modules/.pnpm/x",
    },
  ],
  events: [],
  harnessDeployedApp: true,
  withAccess: false,
  team: null,
  templateMarker: "Simple Todo",
  ...overrides,
});

const deps = (
  fetchImpl: FetchLike,
  runStatus: StatusRunner,
  more: Partial<VerifyDeps> = {},
): VerifyDeps => ({
  fetchImpl,
  runStatus,
  sleep: async () => {},
  now: (() => {
    let t = Date.parse("2026-10-25T14:30:00.000Z");
    return () => new Date((t += 1000));
  })(),
  windowMs: 5_000,
  pollMs: 1000,
  randomLabel: () => "cafe0000",
  ...more,
});

describe("verify: the green path", () => {
  it("passes every row from the outside, with A3 green when the cookie covers the app host", async () => {
    const { fetchImpl, calls } = fakeFetch(healthyRoutes());
    const result = await verify(baseCtx(), deps(fetchImpl, healthyStatus()));
    expect(result.version).toBe(VERIFIER_VERSION);
    expect(rowStatuses(result)).toEqual({
      G1: "pass",
      G2: "pass",
      G3: "pass",
      O1: "pass",
      A1: "pass",
      A2: "pass",
      A3: "pass",
      S1: "pass",
      T1: "pass",
      X1: "skipped",
    });
    expect(result.phaseReached).toBe("app-live");
    expect(result.tainted).toBe(false);
    expect(result.shortcut).toBe(false);
    expect(result.harnessSelfClaimed).toBe(false);
    expect(result.appDeploy).toEqual({
      by: "harness",
      id: "hello",
      url: `https://${appHost}`,
    });
    expect(allRowsGreen(result)).toBe(true);
    // Every probe used redirect: manual and the claim fingerprint went without an Origin.
    expect(calls).toContain(`POST ${origin}/api/setup/claim`);
    expect(calls.filter((c) => c === `GET https://${appHost}/`)).toHaveLength(
      3,
    );
    // The evidence never keeps the cookie value or the password.
    const text = JSON.stringify(result);
    expect(text).not.toContain("session_token=abc");
    expect(text).not.toContain(owner.password);
  });
  it("writes verify.json with mode 600 in a 700 directory", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "loop-verify-")), "run");
    const result = { version: 1 } as unknown as Parameters<
      typeof writeVerifyEvidence
    >[1];
    const path = writeVerifyEvidence(dir, result);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("verify: what each row catches", () => {
  it("G1 retries edge statuses within the window, then fails", async () => {
    const routes = healthyRoutes();
    let hits = 0;
    routes[`GET ${origin}/sign-in`] = () => {
      hits += 1;
      return new Response("", { status: 522 });
    };
    const { fetchImpl } = fakeFetch(routes);
    const result = await verify(baseCtx(), deps(fetchImpl, healthyStatus()));
    expect(result.rows.G1.status).toBe("fail");
    expect(result.rows.G1.attempts).toBeGreaterThan(1);
    expect(hits).toBe(result.rows.G1.attempts);
    expect(result.rows.G1.note).toContain("522");
  });
  it("G2 and G3 fail on a stray wildcard record whose parking page answers 200 everywhere", async () => {
    const routes = healthyRoutes();
    routes[`POST ${origin}/api/setup/claim`] = () =>
      new Response("<html>parked</html>", { status: 200 });
    routes[`GET https://nope-cafe0000.apps.${zone}/`] = () =>
      new Response("<html>parked</html>", { status: 200 });
    const { fetchImpl } = fakeFetch(routes);
    const result = await verify(
      baseCtx({ wildcardAppsRecord: true }),
      deps(fetchImpl, healthyStatus()),
    );
    expect(result.rows.G2.status).toBe("fail");
    expect(result.rows.G3.status).toBe("fail");
    expect(result.rows.G2.attempts).toBe(1);
  });
  it("G3 skips the unknown-host probe when no *.apps.<zone> record exists (the host is NXDOMAIN; setup creates no wildcard) and passes on /api/me/apps alone", async () => {
    const routes = healthyRoutes();
    delete routes[`GET https://nope-cafe0000.apps.${zone}/`];
    const { fetchImpl, calls } = fakeFetch(routes);
    const result = await verify(baseCtx(), deps(fetchImpl, healthyStatus()));
    expect(result.rows.G3.status).toBe("pass");
    expect(result.rows.G3.attempts).toBe(1);
    expect(calls.some((c) => c.includes("nope-"))).toBe(false);
    expect(
      (result.rows.G3.evidence as { nope: { skipped: string } }).nope.skipped,
    ).toContain("no *.apps.<zone> record");
  });
  it("after G1 fails past its window the other rows run once each: a run that died before the gateway costs one window, not four", async () => {
    const routes = healthyRoutes();
    let statusRuns = 0;
    for (const key of Object.keys(routes))
      routes[key] = () => new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    const { fetchImpl } = fakeFetch(routes);
    const result = await verify(
      baseCtx(),
      deps(fetchImpl, async () => {
        statusRuns += 1;
        return {
          exitCode: 1,
          events: [
            {
              v: 1,
              ts: "t",
              type: "error",
              code: "GATEWAY_NOT_FOUND",
              message: "no gateway",
              retryable: false,
            },
          ],
          data: null,
        };
      }),
    );
    expect(result.rows.G1.status).toBe("fail");
    expect(result.rows.G1.attempts).toBeGreaterThan(1);
    for (const id of ["G2", "G3", "O1", "A1", "A2", "S1"] as const)
      expect(result.rows[id].attempts, id).toBeLessThanOrEqual(1);
    expect(statusRuns).toBe(1);
    expect(result.rows.S1.note).toContain("GATEWAY_NOT_FOUND");
    expect(result.phaseReached).toBe("none");
  });
  it("S1 does not re-poll a status that printed GATEWAY_NOT_FOUND: nothing is installed, and 15 minutes of reruns would not change that", async () => {
    let statusRuns = 0;
    const result = await verify(
      baseCtx(),
      deps(fakeFetch(healthyRoutes()).fetchImpl, async () => {
        statusRuns += 1;
        return {
          exitCode: 1,
          events: [
            {
              v: 1,
              ts: "t",
              type: "error",
              code: "GATEWAY_NOT_FOUND",
              message: "no gateway",
              retryable: false,
            },
          ],
          data: null,
        };
      }),
    );
    expect(result.rows.S1.status).toBe("fail");
    expect(statusRuns).toBe(1);
  });
  it("O1 keeps the sign-in body out of the evidence (Better Auth returns the session token in it) and compares emails case-insensitively", async () => {
    const routes = healthyRoutes();
    routes[`POST ${origin}/api/auth/sign-in/email`] = () =>
      new Response(
        JSON.stringify({
          redirect: false,
          token: "SESSION_TOKEN_NEVER_KEPT_0123456789",
          user: { email: owner.email.toUpperCase() },
        }),
        { status: 200, headers: { "set-cookie": COOKIE } },
      );
    routes[`GET ${origin}/api/auth/get-session`] = () =>
      new Response(
        JSON.stringify({ user: { email: owner.email.toUpperCase() } }),
        { status: 200 },
      );
    const result = await verify(
      baseCtx(),
      deps(
        fakeFetch(routes).fetchImpl,
        healthyStatus({ owner: { email: owner.email.toUpperCase() } }),
      ),
    );
    expect(result.rows.O1.status).toBe("pass");
    expect(result.rows.S1.status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain("SESSION_TOKEN_NEVER_KEPT");
    expect(JSON.stringify(result)).toContain("[sign-in body not kept]");
  });
  it("O1 names a refused password in its note without blaming the harness; a different session or owner email is the self-claim", async () => {
    const refused = healthyRoutes();
    refused[`POST ${origin}/api/auth/sign-in/email`] = () =>
      new Response(
        JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "x" }),
        { status: 401 },
      );
    let result = await verify(
      baseCtx(),
      deps(fakeFetch(refused).fetchImpl, healthyStatus()),
    );
    expect(result.rows.O1.status).toBe("fail");
    expect(result.rows.O1.note).toContain("INVALID_EMAIL_OR_PASSWORD");
    // A 401 alone is not a self-claim: an untrusted Origin, a rate limit or an unverified email answer the same.
    expect(result.harnessSelfClaimed).toBe(false);
    expect(result.rows.A3.status).toBe("perimeter-only");

    result = await verify(
      baseCtx(),
      deps(
        fakeFetch(refused).fetchImpl,
        healthyStatus({ owner: { email: `agent@${zone}` } }),
      ),
    );
    expect(result.rows.S1.note).toContain("owner is not the loop's");
    expect(result.harnessSelfClaimed).toBe(true);

    const other = healthyRoutes();
    other[`GET ${origin}/api/auth/get-session`] = () =>
      new Response(JSON.stringify({ user: { email: `agent@${zone}` } }), {
        status: 200,
      });
    result = await verify(
      baseCtx(),
      deps(fakeFetch(other).fetchImpl, healthyStatus()),
    );
    expect(result.rows.O1.status).toBe("fail");
    expect(result.rows.O1.note).toContain("not the loop's owner");
    expect(result.harnessSelfClaimed).toBe(true);
  });
  it("A1 calls a 200 on the app host a finding and a 404 not deployed; A2 wants the 401 signature", async () => {
    const open = healthyRoutes();
    open[`GET https://${appHost}/`] = () =>
      new Response("<html>public</html>", { status: 200 });
    let result = await verify(
      baseCtx(),
      deps(fakeFetch(open).fetchImpl, healthyStatus()),
    );
    expect(result.rows.A1.status).toBe("fail");
    expect(result.rows.A1.note).toContain("no public routes");
    expect(result.rows.A2.status).toBe("fail");

    const missing = healthyRoutes();
    missing[`GET https://${appHost}/`] = () =>
      new Response("", { status: 404 });
    result = await verify(
      baseCtx(),
      deps(fakeFetch(missing).fetchImpl, healthyStatus()),
    );
    expect(result.rows.A1.note).toContain("not deployed");
  });
  it("A1 waits out 503 app_deploying within the window", async () => {
    const routes = healthyRoutes();
    const healthyApp = routes[`GET https://${appHost}/`]!;
    let n = 0;
    routes[`GET https://${appHost}/`] = (init) =>
      n++ < 2
        ? new Response('{"error":"app_deploying"}', { status: 503 })
        : healthyApp(init);
    const result = await verify(
      baseCtx(),
      deps(fakeFetch(routes).fetchImpl, healthyStatus()),
    );
    expect(result.rows.A1.status).toBe("pass");
    expect(result.rows.A1.attempts).toBe(3);
  });
  it("S1 ignores CHECKOUT_BEHIND, re-polls while only settling items remain, fails on warnings", async () => {
    let polls = 0;
    const settling: StatusRunner = async () => {
      polls += 1;
      return polls < 3
        ? {
            exitCode: 0,
            events: [],
            data: {
              claimed: true,
              owner: { email: owner.email },
              upToDate: true,
              apps: [{ id: "hello", status: "active", bound: false }],
              fixes: [{ code: "APP_BINDING", severity: "settling" }],
            },
          }
        : await healthyStatus()();
    };
    let result = await verify(
      baseCtx(),
      deps(fakeFetch(healthyRoutes()).fetchImpl, settling),
    );
    expect(result.rows.S1.status).toBe("pass");
    expect(result.rows.S1.attempts).toBe(3);

    result = await verify(
      baseCtx(),
      deps(
        fakeFetch(healthyRoutes()).fetchImpl,
        healthyStatus({
          fixes: [{ code: "NO_OWNER", severity: "warning" }],
          claimed: false,
          owner: null,
        }),
      ),
    );
    expect(result.rows.S1.status).toBe("fail");
    expect(result.rows.S1.note).toContain("claimed=false");
    expect(result.rows.S1.note).toContain("NO_OWNER");
    expect(result.rows.S1.attempts).toBe(1);

    result = await verify(
      baseCtx(),
      deps(
        fakeFetch(healthyRoutes()).fetchImpl,
        healthyStatus({ upToDate: false }),
      ),
    );
    expect(result.rows.S1.status).toBe("fail");
    expect(result.rows.S1.note).toContain("upToDate=false");
  });
  it("S1 notes an app not named hello", async () => {
    const result = await verify(
      baseCtx(),
      deps(
        fakeFetch(healthyRoutes()).fetchImpl,
        healthyStatus({
          apps: [{ id: "my-app", status: "active", bound: true }],
        }),
      ),
    );
    expect(result.rows.S1.status).toBe("pass");
    expect(result.rows.S1.note).toContain("my-app");
  });
  it("T1 flags taint under the gateway, packages or templates (noise excluded) and shortcuts in tool calls", async () => {
    const events: NormalizedEvent[] = [
      {
        receivedAt: "t",
        kind: "tool_call",
        tool: "Bash",
        argv: ["pnpm", "everyapp", "setup", "--json"],
        raw: null,
      },
      {
        receivedAt: "t",
        kind: "tool_call",
        tool: "Bash",
        argv: ["npx", "wrangler", "d1", "execute", "x"],
        raw: null,
      },
    ];
    const diff = [
      {
        kind: "changed" as const,
        path: "/work/every-app/packages/cli/src/commands/setup/runSetup.ts",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/packages/cli/dist/index.js",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/apps/every-app-gateway/.wrangler/state",
      },
    ];
    expect(detectTaint(diff).map((e) => e.path)).toEqual([
      "/work/every-app/packages/cli/src/commands/setup/runSetup.ts",
    ]);
    // What a clean run leaves: `docker diff` prints every ancestor directory (`C /work/every-app/packages`
    // after pnpm install) and the release build writes .cloudflare/output, .output and .tanstack.
    const clean = [
      { kind: "changed" as const, path: "/work/every-app" },
      { kind: "changed" as const, path: "/work/every-app/packages" },
      { kind: "changed" as const, path: "/work/every-app/packages/cli" },
      {
        kind: "added" as const,
        path: "/work/every-app/packages/cli/node_modules/.pnpm/x",
      },
      {
        kind: "changed" as const,
        path: "/work/every-app/templates/simple-todo",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/templates/simple-todo/node_modules/zod",
      },
      {
        kind: "changed" as const,
        path: "/work/every-app/apps/every-app-gateway",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/apps/every-app-gateway/.cloudflare/output/server/index.js",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/apps/every-app-gateway/.output/x",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/apps/every-app-gateway/.tanstack/x",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/packages/cli/tsconfig.tsbuildinfo",
      },
      {
        kind: "added" as const,
        path: "/work/every-app/apps/every-app-gateway/release-package/gateway.tar.gz",
      },
    ];
    expect(detectTaint(clean)).toEqual([]);
    // `git status --porcelain` from the checkout: tracked changes and unignored additions under the roots only.
    expect(
      taintFromGitStatus([
        " M packages/cli/src/commands/setup/runSetup.ts",
        "?? apps/every-app-gateway/src/routes/public.ts",
        "?? apps/hello/src/index.ts",
        " D templates/simple-todo/README.md",
        "?? packages/cli/dist/index.js",
      ]).map((e) => `${e.kind} ${e.path}`),
    ).toEqual([
      "changed /work/every-app/packages/cli/src/commands/setup/runSetup.ts",
      "added /work/every-app/apps/every-app-gateway/src/routes/public.ts",
      "deleted /work/every-app/templates/simple-todo/README.md",
    ]);
    expect(taintFromGitStatus([])).toEqual([]);
    expect(detectShortcut(events)).toBe(true);
    expect(
      detectShortcut([
        {
          receivedAt: "t",
          kind: "tool_call",
          tool: "Bash",
          text: "curl https://api.cloudflare.com/client/v4/accounts",
          raw: null,
        },
      ]),
    ).toBe(true);
    expect(detectShortcut([events[0]!])).toBe(false);
    const result = await verify(
      baseCtx({ diff, events }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, healthyStatus()),
    );
    expect(result.rows.T1.status).toBe("fail");
    expect(result.tainted).toBe(true);
    expect(result.shortcut).toBe(true);
  });
  it("T1 flags an owner the loop did not create", async () => {
    const result = await verify(
      baseCtx({ claimHow: "none" }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, healthyStatus()),
    );
    expect(result.ownerNotCreatedByLoop).toBe(true);
    expect(result.rows.T1.status).toBe("fail");
  });
  it("runs the verifier's own deploy only when the harness deployed nothing and the registry lists no app, and says so", async () => {
    let probed = 0;
    let statusRuns = 0;
    // The registry is empty until the verifier's own deploy: status before the probe lists no app.
    const statusAfterProbe: StatusRunner = async () => {
      statusRuns += 1;
      return (probed === 0 ? healthyStatus({ apps: [] }) : healthyStatus())();
    };
    const result = await verify(
      baseCtx({ harnessDeployedApp: false, appHost: null }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, statusAfterProbe, {
        deployProbe: async () => {
          probed += 1;
          return { id: "hello", host: appHost };
        },
      }),
    );
    expect(probed).toBe(1);
    expect(statusRuns).toBeGreaterThanOrEqual(2);
    expect(result.appDeploy.by).toBe("verifier");
    expect(result.rows.A1.status).toBe("pass");
    // No event log (no seam in the commit under test), but status lists an app: it is the harness's, no probe.
    let probedAgain = 0;
    const fromStatus = await verify(
      baseCtx({ harnessDeployedApp: false, appHost: null }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, healthyStatus(), {
        deployProbe: async () => {
          probedAgain += 1;
          return null;
        },
      }),
    );
    expect(probedAgain).toBe(0);
    expect(fromStatus.appDeploy).toEqual({
      by: "harness",
      id: "hello",
      url: `https://${appHost}`,
    });
    expect(fromStatus.rows.A1.status).toBe("pass");
    const none = await verify(
      baseCtx({ harnessDeployedApp: false, appHost: null }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, healthyStatus({ apps: [] })),
    );
    expect(none.appDeploy.by).toBe("none");
    expect(none.rows.A1.note).toBe("no app deployed");
    expect(none.phaseReached).toBe("owner");
  });
  it("X1 wants the Access redirect, then access off and G1 again; never folded into the main rows", async () => {
    const routes = healthyRoutes();
    let accessOn = true;
    routes[`GET ${origin}/`] = () =>
      accessOn
        ? new Response("", {
            status: 302,
            headers: {
              location:
                "https://everyapp-loop1.cloudflareaccess.com/cdn-cgi/access/login/apps.everyapp-loop1.com?kid=1",
            },
          })
        : new Response("ok", { status: 200 });
    const result = await verify(
      baseCtx({ withAccess: true, team: "everyapp-loop1" }),
      deps(fakeFetch(routes).fetchImpl, healthyStatus(), {
        accessOff: async () => {
          accessOn = false;
        },
      }),
    );
    expect(result.access).toBe("pass");
    expect(result.rows.X1.status).toBe("pass");
    expect(result.rows.G1.status).toBe("pass");
    expect(result.phaseReached).toBe("access");
    const skipped = await verify(
      baseCtx({ withAccess: true, team: null }),
      deps(fakeFetch(healthyRoutes()).fetchImpl, healthyStatus()),
    );
    expect(skipped.access).toBe("skipped");
    expect(skipped.rows.X1.note).toBe("no team");
  });
});

describe("helpers", () => {
  it("reads status --json's done.data", () => {
    const view = statusView({
      claimed: true,
      owner: { email: "o@x" },
      upToDate: null,
      apps: [{ id: "a", status: "active", bound: true }],
      fixes: [
        { code: "CERT_PENDING", severity: "settling" },
        { code: "APP_NOT_UPLOADED", severity: "warning" },
      ],
    })!;
    expect(view.blocking).toEqual(["APP_NOT_UPLOADED"]);
    expect(view.settling).toEqual(["CERT_PENDING"]);
    expect(view.ownerEmail).toBe("o@x");
    expect(statusView(null)).toBeNull();
  });
  it("walks the phase ladder", () => {
    const rows = {
      G1: "fail",
      G2: "fail",
      G3: "fail",
      O1: "fail",
      A1: "fail",
      A2: "fail",
      A3: "fail",
      S1: "fail",
      T1: "pass",
      X1: "skipped",
    } as const;
    expect(phaseReachedFrom(rows, null, "skipped")).toBe("none");
    expect(phaseReachedFrom({ ...rows, G1: "pass" }, null, "skipped")).toBe(
      "gateway-uploaded",
    );
    expect(
      phaseReachedFrom({ ...rows, G1: "pass", O1: "pass" }, null, "skipped"),
    ).toBe("owner");
    const created = statusView({
      claimed: true,
      apps: [{ id: "hello", status: "pending", bound: false }],
      fixes: [],
    });
    expect(phaseReachedFrom({ ...rows, G1: "pass" }, created, "skipped")).toBe(
      "app-created",
    );
    expect(
      phaseReachedFrom({ ...rows, G1: "pass", A1: "pass" }, created, "skipped"),
    ).toBe("app-deployed");
    expect(
      phaseReachedFrom(
        { ...rows, G1: "pass", A1: "pass", A2: "pass" },
        created,
        "skipped",
      ),
    ).toBe("app-live");
  });
});
