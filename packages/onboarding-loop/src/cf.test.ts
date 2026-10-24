import { describe, expect, it } from "vitest";
import {
  CfApiError,
  createCfApi,
  createFakeCfFetch,
  tokenGate,
  type FakeCfRoute,
} from "./cf";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const FORBIDDEN = "23bc28f0b638fbfc1c7f838573c17ee3";
const TOKEN = "fake-token-abcdefghijklmnopqrstuv";

const okRoutes = (
  accounts: string[] = [ID],
  status = "active",
): FakeCfRoute[] => [
  {
    method: "GET",
    path: /^\/user\/tokens\/verify$/,
    reply: () => ({ result: { id: "tok", status } }),
  },
  {
    method: "GET",
    path: /^\/accounts$/,
    reply: () => ({
      result: accounts.map((id) => ({ id, name: `acct ${id.slice(0, 4)}` })),
    }),
  },
];

const api = (routes: FakeCfRoute[]) => {
  const fake = createFakeCfFetch(routes);
  return {
    ...fake,
    cf: createCfApi({ token: TOKEN, accountId: ID, fetch: fake.fetch }),
  };
};

describe("cf", () => {
  it("sends the bearer token and parses the envelope", async () => {
    const { cf, calls } = api(okRoutes());
    expect(await cf.verifyToken()).toEqual({ id: "tok", status: "active" });
    // An account-owned token is tried first; a user token falls back to /user/tokens/verify.
    expect(calls.slice(0, 2)).toEqual([
      { method: "GET", path: `/accounts/${ID}/tokens/verify`, body: undefined },
      { method: "GET", path: "/user/tokens/verify", body: undefined },
    ]);
  });

  it("verifies an account-owned token at the account endpoint, where the user endpoint refuses it", async () => {
    const { cf, calls } = api([
      {
        method: "GET",
        path: new RegExp(`^/accounts/${ID}/tokens/verify$`),
        reply: () => ({ result: { id: "acct-tok", status: "active" } }),
      },
      {
        method: "GET",
        path: /^\/user\/tokens\/verify$/,
        reply: () => ({
          status: 401,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
      },
      ...okRoutes().filter(
        (route) => !/tokens\/verify/.test(String(route.path)),
      ),
    ]);
    expect(await cf.verifyToken()).toEqual({
      id: "acct-tok",
      status: "active",
    });
    expect(calls.map((call) => call.path)).toEqual([
      `/accounts/${ID}/tokens/verify`,
    ]);
    expect(await tokenGate(cf, ID)).toMatchObject({ ok: true });
  });

  it("walks every page of a list", async () => {
    const pages = [[{ id: ID, name: "a" }], [{ id: OTHER, name: "b" }]];
    const { cf, calls } = api([
      {
        method: "GET",
        path: /^\/accounts$/,
        reply: (_m, call) => ({
          result: pages[Number(/[?&]page=(\d+)/.exec(call.path)?.[1]) - 1],
          total_pages: 2,
        }),
      },
    ]);
    expect(await cf.listAccounts()).toEqual([
      { id: ID, name: "a" },
      { id: OTHER, name: "b" },
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      "/accounts?per_page=100&page=1",
      "/accounts?per_page=100&page=2",
    ]);
  });

  it("D1 list by name and query with params", async () => {
    const { cf, calls } = api([
      {
        method: "GET",
        path: /^\/accounts\/([0-9a-f]+)\/d1\/database$/,
        reply: () => ({ result: [{ uuid: "db1", name: "every-app-gateway" }] }),
      },
      {
        method: "POST",
        path: /^\/accounts\/[0-9a-f]+\/d1\/database\/db1\/query$/,
        reply: () => ({
          result: [
            { results: [{ id: 7 }], success: true, meta: { changes: 0 } },
          ],
        }),
      },
    ]);
    expect(await cf.d1List("every-app-gateway")).toEqual([
      { uuid: "db1", name: "every-app-gateway" },
    ]);
    expect(calls[0]?.path).toBe(
      `/accounts/${ID}/d1/database?name=every-app-gateway&per_page=100&page=1`,
    );
    const rows = await cf.d1Query(
      "db1",
      "SELECT id FROM owner_setup_tokens WHERE kind = ?",
      ["claim"],
    );
    expect(rows[0]?.results).toEqual([{ id: 7 }]);
    expect(calls[1]?.body).toEqual({
      sql: "SELECT id FROM owner_setup_tokens WHERE kind = ?",
      params: ["claim"],
    });
  });

  it("the workers.dev subdomain: 404 reads as none, PUT registers one", async () => {
    let registered: string | null = null;
    const { cf, calls } = api([
      {
        method: "GET",
        path: /\/workers\/subdomain$/,
        reply: () =>
          registered
            ? { result: { subdomain: registered } }
            : { status: 404, errors: [{ code: 10007, message: "not found" }] },
      },
      {
        method: "PUT",
        path: /\/workers\/subdomain$/,
        reply: (_m, call) => {
          registered = (call.body as { subdomain: string }).subdomain;
          return { result: { subdomain: registered } };
        },
      },
    ]);
    expect(await cf.getWorkersSubdomain()).toBeNull();
    expect(await cf.putWorkersSubdomain("everyapp-loop1")).toBe(
      "everyapp-loop1",
    );
    expect(calls[1]?.body).toEqual({ subdomain: "everyapp-loop1" });
    expect(await cf.getWorkersSubdomain()).toBe("everyapp-loop1");
  });

  it("zones, DNS records and KV namespaces", async () => {
    const { cf, calls } = api([
      {
        method: "GET",
        path: /^\/zones$/,
        reply: () => ({
          result: [
            {
              id: "z1",
              name: "everyapp-loop1.com",
              status: "active",
              name_servers: ["a.ns.cloudflare.com"],
            },
          ],
        }),
      },
      {
        method: "GET",
        path: /^\/zones\/z1\/dns_records$/,
        reply: () => ({
          result: [
            {
              id: "r1",
              type: "A",
              name: "apps.everyapp-loop1.com",
              content: "192.0.2.1",
            },
          ],
        }),
      },
      {
        method: "GET",
        path: /\/storage\/kv\/namespaces$/,
        reply: () => ({ result: [{ id: "kv1", title: "every-loop-run-x" }] }),
      },
      {
        method: "POST",
        path: /\/storage\/kv\/namespaces$/,
        reply: (_m, call) => ({
          result: { id: "kv2", title: (call.body as { title: string }).title },
        }),
      },
    ]);
    expect((await cf.listZones("everyapp-loop1.com"))[0]?.id).toBe("z1");
    expect(calls[0]?.path).toBe(
      "/zones?name=everyapp-loop1.com&per_page=100&page=1",
    );
    expect(await cf.dnsRecordsList("z1")).toEqual([
      {
        id: "r1",
        type: "A",
        name: "apps.everyapp-loop1.com",
        content: "192.0.2.1",
      },
    ]);
    expect(await cf.kvNamespacesList()).toEqual([
      { id: "kv1", title: "every-loop-run-x" },
    ]);
    expect(await cf.kvNamespaceCreate("every-loop-run-y")).toEqual({
      id: "kv2",
      title: "every-loop-run-y",
    });
  });

  it("an error answer is a CfApiError with the codes and never the token", async () => {
    const { cf } = api([
      {
        method: "GET",
        path: /^\/user\/tokens\/verify$/,
        reply: () => ({
          status: 400,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
      },
    ]);
    const error = await cf.verifyToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CfApiError);
    expect((error as CfApiError).status).toBe(400);
    expect((error as CfApiError).message).toContain("1000 Invalid API Token");
    expect((error as CfApiError).message).not.toContain(TOKEN);
    const unrouted = api([]);
    await expect(unrouted.cf.subscriptions()).rejects.toThrow(/404/);
  });
});

describe("tokenGate", () => {
  it("passes an active token that sees exactly the account", async () => {
    expect(await tokenGate(api(okRoutes()).cf, ID)).toEqual({
      ok: true,
      accounts: [ID],
    });
  });

  it("a rejected or inactive token is token_rejected", async () => {
    const rejected = api([
      {
        method: "GET",
        path: /^\/user\/tokens\/verify$/,
        reply: () => ({
          status: 400,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
      },
    ]);
    expect(await tokenGate(rejected.cf, ID)).toMatchObject({
      ok: false,
      code: "token_rejected",
    });
    expect(
      await tokenGate(api(okRoutes([ID], "disabled")).cf, ID),
    ).toMatchObject({ ok: false, code: "token_rejected" });
  });

  it("too broad, not visible, and forbidden", async () => {
    expect(await tokenGate(api(okRoutes([ID, OTHER])).cf, ID)).toMatchObject({
      ok: false,
      code: "token_too_broad",
    });
    expect(await tokenGate(api(okRoutes([OTHER])).cf, ID)).toMatchObject({
      ok: false,
      code: "account_not_visible",
    });
    expect(
      await tokenGate(api(okRoutes([ID, FORBIDDEN])).cf, ID),
    ).toMatchObject({ ok: false, code: "account_forbidden" });
    const forbidden = api(okRoutes([FORBIDDEN]));
    expect(await tokenGate(forbidden.cf, FORBIDDEN)).toMatchObject({
      ok: false,
      code: "account_forbidden",
    });
    // Refused by constant before any call.
    expect(forbidden.calls).toHaveLength(0);
  });

  it("a 5xx from verify is not a verdict on the token", async () => {
    const down = api([
      {
        method: "GET",
        path: /^\/user\/tokens\/verify$/,
        reply: () => ({
          status: 502,
          errors: [{ code: 0, message: "bad gateway" }],
        }),
      },
    ]);
    await expect(tokenGate(down.cf, ID)).rejects.toThrow(CfApiError);
  });
});
