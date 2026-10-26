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
    // An OAuth provider is its own kind (oauthSpec.test.ts); bare, it
    // names what it lacks.
    expect(problems({ ...base, auth: { kind: "oauth2-user" } })).toEqual([
      "auth.authorizeUrl: required",
      "auth.tokenUrl: required",
      "auth.clientId: must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (GITHUB_CLIENT_ID)",
      'scopeSets: required: at least one named set, { "repo.read": { "label", "access", "scopes" } }',
    ]);
    expect(problems({ ...base, auth: { kind: "oauth1" } })).toEqual([
      "auth.secret: must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (STRIPE_API_KEY)",
      "auth.kind: must be bearer, header, query, basic or oauth2-user (an AI provider is a catalog entry, not a spec this gateway takes)",
    ]);
    // `mode: "ai"` is its own kind now (the ai spec tests below): an
    // API-key spec's fields are refused on it, and its own are required.
    expect(
      problems({
        ...base,
        mode: "ai",
        auth: { kind: "bearer", secret: "X_API_KEY" },
      }),
    ).toEqual([
      "hosts: not a field of an ai spec",
      "baseUrl: required: the https URL the app's paths are joined onto (https://api.groq.com/openai)",
      "models: required: the models the provider serves, at least one",
      "defaultModel: required: the chat model the Gateway fills in when an app names none; one of models",
    ]);
    expect(
      problems({
        ...base,
        mode: "other",
        auth: { kind: "bearer", secret: "X_API_KEY" },
      }),
    ).toEqual([
      'mode: this gateway registers api_key, oauth_client (auth.kind oauth2-user) and ai (mode: "ai", an OpenAI-compatible model provider) providers',
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
      if (parsed.ok && parsed.capability.mode === "api_key") {
        expect(parsed.capability.cost?.responseField).toBe(field);
      }
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

describe("parseProviderSpec with mode ai", () => {
  const GROQ = {
    id: "groq-compat",
    mode: "ai",
    name: "Groq (OpenAI-compatible)",
    description: "Fast open models through OpenAI's API shape.",
    docs: "https://console.groq.com/keys",
    api: "https://console.groq.com/docs/openai",
    baseUrl: "https://api.groq.com/openai",
    auth: { kind: "bearer", secret: "GROQ_COMPAT_API_KEY" },
    models: ["llama-4-scout", "llama-4-maverick", "nomic-embed"],
    defaultModel: "llama-4-scout",
    embeddingsModel: "nomic-embed",
    cost: { unit: "token", responseField: "usage.cost" },
    hint: "A key from the Groq console.",
  };

  it("parses an OpenAI-compatible provider into an ai capability, defaults filled, and round-trips it", () => {
    const parsed = parseProviderSpec(GROQ);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const capability = parsed.capability;
    expect(capability.mode).toBe("ai");
    if (capability.mode !== "ai") return;
    expect(capability).toMatchObject({
      label: "Groq (OpenAI-compatible)",
      origin: "https://api.groq.com",
      basePath: "/openai",
      inferenceRoutes: ["/v1/chat/completions", "/v1/embeddings"],
      unstoredRoutes: ["/v1/chat/completions"],
      shape: "openai",
      chat: { path: "/v1/chat/completions", seedModel: "llama-4-scout" },
      embeddings: { path: "/v1/embeddings", seedModel: "nomic-embed" },
      models: ["llama-4-scout", "llama-4-maverick", "nomic-embed"],
      cost: { unit: "token", responseField: "usage.cost" },
    });
    const spec = providerSpecOf("groq-compat", capability);
    expect(spec).toMatchObject({
      mode: "ai",
      baseUrl: "https://api.groq.com/openai",
      routes: ["/v1/chat/completions", "/v1/embeddings"],
      chatRoute: "/v1/chat/completions",
    });
    const again = parseProviderSpec(spec);
    expect(again.ok && again.capability).toEqual(capability);
  });

  it("takes custom routes and a base URL without a path, and never stores chat", () => {
    const parsed = parseProviderSpec({
      ...GROQ,
      baseUrl: "https://api.vendor.example",
      embeddingsModel: undefined,
      routes: ["/v1/chat/completions", "/v1/completions", "/v1/audio/speech"],
    });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok || parsed.capability.mode !== "ai") return;
    expect(parsed.capability.basePath).toBeUndefined();
    expect(parsed.capability.inferenceRoutes).toEqual([
      "/v1/chat/completions",
      "/v1/completions",
      "/v1/audio/speech",
    ]);
    expect(parsed.capability.embeddings).toBeUndefined();
  });

  it("holds every field to its rule", () => {
    expect(problems({ ...GROQ, baseUrl: undefined })).toEqual([
      "baseUrl: required: the https URL the app's paths are joined onto (https://api.groq.com/openai)",
    ]);
    expect(problems({ ...GROQ, baseUrl: "http://api.groq.com" })).toEqual([
      "baseUrl: must be an https URL",
    ]);
    expect(
      problems({ ...GROQ, baseUrl: "https://api.groq.com:8443/openai" }),
    ).toEqual([
      "baseUrl: must be an https URL with no query, fragment, credentials or port",
    ]);
    expect(problems({ ...GROQ, baseUrl: "https://localhost/v1" })).toEqual([
      "baseUrl: must name a public host with a dot (api.groq.com)",
    ]);
    expect(problems({ ...GROQ, models: [] })).toEqual([
      "models: required: the models the provider serves, at least one",
      "defaultModel: must be one of models",
      "embeddingsModel: must be one of models",
    ]);
    expect(problems({ ...GROQ, defaultModel: "gpt-6" })).toEqual([
      "defaultModel: must be one of models",
    ]);
    expect(problems({ ...GROQ, embeddingsModel: "other" })).toEqual([
      "embeddingsModel: must be one of models",
    ]);
    expect(problems({ ...GROQ, routes: ["/v1/embeddings"] })).toEqual([
      "chatRoute: must be one of routes",
    ]);
    expect(
      problems({ ...GROQ, routes: ["/v1/chat/completions", "../v1/files"] }),
    ).toEqual([
      "routes.1: must be a path of lowercase segments starting with / (/v1/chat/completions)",
      "embeddingsRoute: must be one of routes",
    ]);
    expect(
      problems({ ...GROQ, hosts: ["api.groq.com"], access: ["read"] }),
    ).toEqual([
      "hosts: not a field of an ai spec",
      "access: not a field of an ai spec",
    ]);
    expect(problems({ ...GROQ, auth: { kind: "oauth2-user" } })).toContain(
      "auth.kind: an ai spec's key is a bearer, header, query or basic key, never oauth2-user",
    );
    expect(problems({ ...STRIPE, mode: "ai" })).toContain(
      "hosts: not a field of an ai spec",
    );
  });
});
