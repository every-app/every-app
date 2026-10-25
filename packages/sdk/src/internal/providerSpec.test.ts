import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_IDS, type Capability } from "./capabilities";
import {
  describeSpecProblems,
  parseProviderSpec,
  providerSpecOf,
  writeMethodsOf,
} from "./providerSpec";

const STRIPE = {
  id: "stripe",
  name: "Stripe",
  description: "Payments.",
  docs: "https://dashboard.stripe.com/apikeys",
  api: "https://docs.stripe.com/api",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
  secrets: [{ name: "STRIPE_API_KEY", hint: "A restricted key is enough." }],
  access: ["read", "write"],
  readMethods: ["GET", "HEAD"],
  writeMethods: ["POST"],
  accountWidePaths: [["v1", "account"]],
  data: "account",
  hint: "A restricted key from the dashboard.",
  smoke: { method: "GET", path: "/v1/balance", expect: [200], free: true },
  cost: { unit: "call", usd: 0, note: "Free." },
  rate: { perSecond: 100 },
  example: "list my latest customers",
  verified: { on: "2026-10-25", how: "docs" },
  tags: ["payments"],
};

function problems(input: unknown): string[] {
  const parsed = parseProviderSpec(input);
  return parsed.ok ? [] : parsed.problems.map((p) => `${p.path}: ${p.message}`);
}

describe("parseProviderSpec", () => {
  it("parses a full spec into a catalog-shaped capability, and round-trips it", () => {
    const parsed = parseProviderSpec(STRIPE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.id).toBe("stripe");
    expect(parsed.capability).toMatchObject({
      mode: "api_key",
      label: "Stripe",
      auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
      hosts: ["api.stripe.com"],
      access: ["read", "write"],
      readMethods: ["GET", "HEAD"],
      writeMethods: ["POST"],
      accountWidePaths: [["v1", "account"]],
      data: "account",
      hint: "A restricted key from the dashboard.",
      smoke: { method: "GET", path: "/v1/balance", expect: [200], free: true },
    });
    expect(providerSpecOf(parsed.id, parsed.capability)).toEqual(STRIPE);
  });

  it("fills the defaults in: read access, GET and HEAD, no account-wide paths", () => {
    const parsed = parseProviderSpec({
      id: "exa",
      name: "Exa",
      docs: "https://dashboard.exa.ai/api-keys",
      hosts: ["api.exa.ai"],
      auth: { kind: "header", secret: "EXA_API_KEY", header: "x-api-key" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.capability).toMatchObject({
      access: ["read"],
      readMethods: ["GET", "HEAD"],
      accountWidePaths: [],
    });
    expect(writeMethodsOf(parsed.capability)).toEqual([
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
  });

  it("takes every auth kind the gateway puts on a request, and nothing else", () => {
    const base = {
      id: "xx",
      name: "Xx",
      docs: "https://x.example/keys",
      hosts: ["api.x.example"],
    };
    for (const auth of [
      { kind: "bearer", secret: "X_API_KEY", scheme: "Token" },
      { kind: "header", secret: "X_API_KEY", header: "X-Api-Key", prefix: "" },
      { kind: "query", secret: "X_API_KEY", param: "appid" },
      { kind: "basic", secret: "X_API_KEY", as: "password", user: "api" },
      {
        kind: "basic",
        secret: "X_AUTH_TOKEN",
        as: "password",
        user: { secret: "X_ACCOUNT_SID" },
      },
      { kind: "basic", secret: "X_API_KEY", as: "username" },
      { kind: "basic", secret: "X_API_KEY", as: "pair" },
    ]) {
      expect(problems({ ...base, auth }), JSON.stringify(auth)).toEqual([]);
    }
    expect(problems({ ...base, auth: { kind: "oauth2-user" } })).toEqual([
      "auth.secret: must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (STRIPE_API_KEY)",
      "auth.kind: must be bearer, header, query or basic (an OAuth client or an AI provider is a catalog entry, not a spec this gateway takes)",
    ]);
    expect(
      problems({
        ...base,
        mode: "ai",
        auth: { kind: "bearer", secret: "X_API_KEY" },
      }),
    ).toEqual([
      "mode: this gateway registers api_key providers; an AI provider or an OAuth client is a catalog entry",
    ]);
  });

  it("makes basic say where the key goes, and refuses a header the gateway owns", () => {
    const base = {
      id: "xx",
      name: "Xx",
      docs: "https://x.example/keys",
      hosts: ["api.x.example"],
    };
    expect(
      problems({ ...base, auth: { kind: "basic", secret: "X_API_KEY" } }),
    ).toEqual([
      'auth.as: must say where the key goes: "password" (beside user), "username" (with an empty password), or "pair" (the key is login:password)',
    ]);
    expect(
      problems({
        ...base,
        auth: { kind: "basic", secret: "X_API_KEY", as: "password" },
      }),
    ).toEqual([
      "auth.user: required with as: password: a string, or { secret: NAME }",
    ]);
    expect(
      problems({
        ...base,
        auth: { kind: "basic", secret: "X_API_KEY", as: "pair", user: "api" },
      }),
    ).toEqual(["auth.user: not a field of auth.as pair"]);
    for (const header of [
      "Host",
      "cookie",
      "Transfer-Encoding",
      "x-everyapp-identity",
    ]) {
      expect(
        problems({
          ...base,
          auth: { kind: "header", secret: "X_API_KEY", header },
        }),
      ).toEqual([
        `auth.header: ${header} is a header the Gateway sets or strips itself`,
      ]);
    }
    expect(
      problems({
        ...base,
        auth: { kind: "header", secret: "X_API_KEY", header: "bad header" },
      }),
    ).toEqual([
      "auth.header: must be a header name (letters, digits, hyphens)",
    ]);
  });

  it("names every problem at once, with its path", () => {
    expect(
      problems({
        id: "Bad Id",
        docs: "http://plain.example",
        hosts: ["https://api.x.example", "api.x.example:443", "localhost"],
        auth: { kind: "bearer", secret: "lowercase" },
        access: ["admin"],
        readMethods: ["FETCH"],
        accountWidePaths: [["v1", "Account"]],
        secrets: [{ name: "OTHER_KEY" }],
        smoke: { method: "DELETE", path: "no-slash", expect: [], free: "yes" },
        cost: { unit: "hour" },
        verified: "yes",
        tags: ["Payments"],
        extra: true,
      }),
    ).toEqual([
      "extra: unknown field",
      "id: must be lowercase letters, digits and hyphens, a letter first, 2 to 40 characters (stripe)",
      "name: required",
      "docs: must be an https URL",
      "hosts.0: must be a bare lowercase host with a dot and no port, path or scheme (api.stripe.com)",
      "hosts.1: must be a bare lowercase host with a dot and no port, path or scheme (api.stripe.com)",
      "hosts.2: must be a bare lowercase host with a dot and no port, path or scheme (api.stripe.com)",
      "auth.secret: must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (STRIPE_API_KEY)",
      "secrets.0.name: auth names no setting OTHER_KEY",
      "access.0: must be read or write",
      "readMethods.0: must be one of GET, HEAD, POST, PUT, PATCH, DELETE",
      "accountWidePaths.0.1: must be a lowercase path segment (letters, digits, _ and -)",
      "smoke.method: must be GET, HEAD or POST",
      "smoke.path: must start with one /",
      "smoke.expect: must list the HTTP statuses that mean the key works",
      "smoke.free: must be true or false",
      "cost.unit: must be call, result or token",
      'verified: must be false, or { "on": "YYYY-MM-DD", "how": "docs" | "live" }',
      "tags.0: must be a lowercase word",
    ]);
    expect(
      describeSpecProblems([
        { path: "a", message: "b" },
        { path: "c", message: "d" },
      ]),
    ).toBe("a: b; c: d");
    expect(problems("not an object")).toEqual([
      "(root): must be a JSON object",
    ]);
  });

  it("takes a host setting in place of hosts, named apart from the key", () => {
    const shopify = {
      id: "shopify",
      name: "Shopify",
      docs: "https://shopify.dev/",
      hostSetting: "SHOPIFY_HOST",
      auth: {
        kind: "header",
        secret: "SHOPIFY_API_KEY",
        header: "X-Shopify-Access-Token",
      },
    };
    const parsed = parseProviderSpec(shopify);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.capability).toMatchObject({
      hosts: [],
      hostSetting: "SHOPIFY_HOST",
    });
    expect(problems({ ...shopify, hostSetting: "SHOPIFY_API_KEY" })).toEqual([
      "hostSetting: must be another setting than the key",
    ]);
    expect(problems({ ...shopify, hostSetting: undefined })).toEqual([
      "hosts: required: at least one host, or a hostSetting naming one",
    ]);
  });

  it("round-trips every API-key entry of the catalog through its JSON form", () => {
    for (const id of CAPABILITY_IDS) {
      const capability: Capability = CAPABILITIES[id];
      if (capability.mode !== "api_key") continue;
      const spec = providerSpecOf(id, capability);
      const parsed = parseProviderSpec(JSON.parse(JSON.stringify(spec)));
      expect(
        parsed.ok,
        `${id}: ${parsed.ok ? "" : describeSpecProblems(parsed.problems)}`,
      ).toBe(true);
      if (!parsed.ok) continue;
      // The catalog's guide path is the one field the JSON shape doesn't carry.
      const { setup: _setup, ...withoutGuide } = capability;
      expect(parsed.capability).toEqual(withoutGuide);
    }
  });
});

describe("cost.responseField", () => {
  const spec = (responseField: string) => ({
    id: "woodgrove",
    name: "Woodgrove",
    docs: "https://woodgrove.io/keys",
    hosts: ["api.woodgrove.io"],
    auth: { kind: "bearer", secret: "WOODGROVE_API_KEY" },
    cost: { unit: "call", responseField },
  });

  it("takes a field name or a dotted path to a nested one, and refuses anything else", () => {
    for (const field of ["cost", "usage.cost", "data.usage.total_cost"]) {
      const parsed = parseProviderSpec(spec(field));
      expect(parsed.ok, field).toBe(true);
      if (parsed.ok) expect(parsed.capability.cost?.responseField).toBe(field);
    }
    for (const field of [
      "usage.",
      ".cost",
      "usage..cost",
      "usage cost",
      "a.b.c.d.e",
      "cost[0]",
    ]) {
      const parsed = parseProviderSpec(spec(field));
      expect(parsed.ok, field).toBe(false);
      if (!parsed.ok) {
        expect(describeSpecProblems(parsed.problems)).toContain(
          "cost.responseField: must be a JSON field name, or a dotted path to a nested one",
        );
      }
    }
  });
});
