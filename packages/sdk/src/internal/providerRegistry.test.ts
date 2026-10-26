import { describe, expect, it } from "vitest";
import { aiDefaultCandidates, resolveAiDefault } from "./aiDefault";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
} from "./capabilities";
import {
  BUILTIN_PROVIDERS,
  gatewayHostRefusal,
  providerRegistry,
  providerSettingPrefix,
  publicHostProblem,
  rowSecretProblem,
  providerBindingKey,
  registrableHosts,
} from "./providerRegistry";

const northwind = {
  id: "northwind",
  spec: {
    id: "northwind",
    name: "Northwind",
    docs: "https://developer.northwind.io/keys",
    hosts: ["api.northwind.io"],
    auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
  },
};

describe("the built-in registry", () => {
  it("is the catalog, in catalog order, with every setting it reads", () => {
    expect(BUILTIN_PROVIDERS.ids()).toEqual(CAPABILITY_IDS);
    expect(BUILTIN_PROVIDERS.sourceOf("dataforseo")).toBe("catalog");
    expect(BUILTIN_PROVIDERS.sourceOf("northwind")).toBeUndefined();
    expect(BUILTIN_PROVIDERS.settingNames().has("DATAFORSEO_API_KEY")).toBe(
      true,
    );
    expect(BUILTIN_PROVIDERS.settingNames().has("OPENAI_API_KEY")).toBe(true);
    expect(BUILTIN_PROVIDERS.rejected).toEqual([]);
  });

  it("names every catalog provider's settings after its own id", () => {
    for (const id of CAPABILITY_IDS) {
      const capability = CAPABILITIES[id];
      if (capability.mode === "service") continue;
      for (const name of capabilitySettings(capability)) {
        // Workers AI's account is the install's, not the provider's.
        if (name === "CLOUDFLARE_ACCOUNT_ID") continue;
        expect(
          name.startsWith(providerSettingPrefix(id)),
          `${id}: ${name}`,
        ).toBe(true);
      }
    }
    expect(providerSettingPrefix("tiktok-business")).toBe("TIKTOK_BUSINESS_");
  });
});

describe("a registry with rows", () => {
  it("adds a row after the catalog, with its settings, as a JSON string or an object", () => {
    const registry = providerRegistry([
      northwind,
      {
        id: "contoso",
        spec: JSON.stringify({
          ...northwind.spec,
          id: "contoso",
          name: "Contoso",
          hosts: ["api.contoso.dev"],
          auth: {
            kind: "header",
            secret: "CONTOSO_API_KEY",
            header: "x-api-key",
          },
        }),
      },
    ]);
    expect(registry.rejected).toEqual([]);
    expect(registry.ids()).toEqual([...CAPABILITY_IDS, "northwind", "contoso"]);
    expect(registry.sourceOf("northwind")).toBe("row");
    expect(registry.get("northwind")).toMatchObject({
      mode: "api_key",
      label: "Northwind",
    });
    expect(registry.settingNames().has("NORTHWIND_API_KEY")).toBe(true);
    expect(registry.settingNames().has("CONTOSO_API_KEY")).toBe(true);
  });

  it("never lets a row shadow the catalog or take the reserved id", () => {
    const registry = providerRegistry([
      {
        id: "dataforseo",
        spec: {
          ...northwind.spec,
          id: "dataforseo",
          auth: { kind: "bearer", secret: "DATAFORSEO_OTHER" },
        },
      },
      {
        id: "everyapp",
        spec: {
          ...northwind.spec,
          id: "everyapp",
          auth: { kind: "bearer", secret: "EVERYAPP_X" },
        },
      },
    ]);
    expect(registry.get("dataforseo")).toBe(CAPABILITIES.dataforseo);
    expect(registry.rejected.map((r) => [r.id, r.code])).toEqual([
      ["dataforseo", "PROVIDER_BUILTIN"],
      ["everyapp", "PROVIDER_BUILTIN"],
    ]);
  });

  it.each([
    // The prefix rule first: a name outside the row's own id is nobody's to take.
    [
      "a setting outside its prefix",
      "xx",
      "JWT_PRIVATE_KEY",
      "doesn't start with XX_",
    ],
    ["a catalog key", "xx", "OPENAI_API_KEY", "doesn't start with XX_"],
    // Under the prefix, the Gateway's own and the catalog's names are still refused.
    [
      "the Gateway's signing key under its prefix",
      "jwt",
      "JWT_PRIVATE_KEY",
      "is one of the Gateway's own keys",
    ],
    [
      "a Gateway setting under its prefix",
      "mcp",
      "MCP_OAUTH_ENABLED",
      "is a Gateway setting",
    ],
    [
      "a dev-only setting under its prefix",
      "mcp",
      "MCP_ACCESS_TOKEN_TTL",
      "is a local-development setting",
    ],
    [
      "a reserved app name under its prefix",
      "every-app",
      "EVERY_APP_ORG_ID",
      "is a name everyapp sets itself",
    ],
  ])("refuses a row naming %s", (_what, id, name, reason) => {
    const registry = providerRegistry([
      {
        id,
        spec: {
          ...northwind.spec,
          id,
          hosts: ["api.x.example"],
          auth: { kind: "bearer", secret: name },
        },
      },
    ]);
    expect(registry.get(id)).toBeUndefined();
    expect(registry.rejected[0]).toMatchObject({
      id,
      code: "PROVIDER_SECRET_TAKEN",
    });
    expect(registry.rejected[0]!.message).toContain(reason);
  });

  it("refuses the prefix rule's other cases through rowSecretProblem", () => {
    expect(rowSecretProblem("xx", "XX_API_KEY", () => false)).toBeNull();
    expect(
      rowSecretProblem("xx", "XX_API_KEY", (n) => n === "XX_API_KEY"),
    ).toBe("XX_API_KEY is another registered provider's");
    expect(rowSecretProblem("my-api", "MY_API_TOKEN", () => false)).toBeNull();
    expect(rowSecretProblem("my-api", "MYAPI_TOKEN", () => false)).toContain(
      "MY_API_",
    );
  });

  it("gives a second row naming the first's setting to the first", () => {
    const registry = providerRegistry([
      northwind,
      {
        id: "northwind-eu",
        spec: {
          ...northwind.spec,
          id: "northwind-eu",
          hosts: ["api.northwind.io"],
          auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
        },
      },
    ]);
    expect(registry.get("northwind")).toBeDefined();
    expect(registry.rejected).toEqual([
      {
        id: "northwind-eu",
        code: "PROVIDER_SECRET_TAKEN",
        message:
          "NORTHWIND_API_KEY doesn't start with NORTHWIND_EU_: a provider's settings carry its own id",
      },
    ]);
  });

  it("refuses hosts that aren't public, and the ones this gateway serves", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "app.localhost",
      "gateway.internal",
      "db.local",
      "x.arpa",
    ]) {
      expect(publicHostProblem(host), host).not.toBeNull();
    }
    expect(publicHostProblem("api.northwind.io")).toBeNull();
    const registry = providerRegistry(
      [
        {
          id: "aa",
          spec: {
            ...northwind.spec,
            id: "aa",
            hosts: ["10.0.0.1"],
            auth: { kind: "bearer", secret: "AA_KEY" },
          },
        },
        {
          id: "bb",
          spec: {
            ...northwind.spec,
            id: "bb",
            hosts: ["crm.apps.example.com"],
            auth: { kind: "bearer", secret: "BB_KEY" },
          },
        },
        {
          id: "cc",
          spec: {
            ...northwind.spec,
            id: "cc",
            hosts: ["api.c.example"],
            auth: { kind: "bearer", secret: "CC_KEY" },
          },
        },
      ],
      {
        refuseHost: (host) =>
          host.endsWith(".apps.example.com")
            ? `${host} is one of this gateway's app hosts`
            : null,
      },
    );
    expect(registry.rejected.map((r) => [r.id, r.code])).toEqual([
      ["aa", "PROVIDER_HOST_REFUSED"],
      ["bb", "PROVIDER_HOST_REFUSED"],
    ]);
    expect(registry.get("cc")).toBeDefined();
  });

  it("drops a row whose spec doesn't parse or doesn't match its id, naming why", () => {
    const registry = providerRegistry([
      { id: "xx", spec: "{not json" },
      {
        id: "yy",
        spec: {
          ...northwind.spec,
          id: "zz",
          auth: { kind: "bearer", secret: "ZZ_KEY" },
        },
      },
      { id: "ww", spec: { id: "ww" } },
    ]);
    expect(registry.rejected.map((r) => r.id)).toEqual(["xx", "yy", "ww"]);
    expect(registry.rejected[0]!.message).toBe("the stored spec isn't JSON");
    expect(registry.rejected[1]!.message).toBe(
      "the row is yy but its spec says zz",
    );
    expect(registry.rejected[2]!.code).toBe("PROVIDER_SPEC_INVALID");
    expect(registry.ids()).toEqual(CAPABILITY_IDS);
  });
});

describe("gatewayHostRefusal", () => {
  const hosts = {
    gatewayHost: "apps.example.com",
    appBaseDomain: "apps.example.com",
    thirdPartyDomain: "usercontent.example.net",
  };

  it("refuses the gateway's own host, its app hosts and its third-party hosts, in the gateway's words", () => {
    expect(gatewayHostRefusal("apps.example.com", hosts)).toBe(
      "apps.example.com is this gateway's own host",
    );
    expect(gatewayHostRefusal("crm.apps.example.com", hosts)).toBe(
      "crm.apps.example.com is under this gateway's app domain apps.example.com",
    );
    expect(gatewayHostRefusal("x.usercontent.example.net", hosts)).toBe(
      "x.usercontent.example.net is under this gateway's third-party domain usercontent.example.net",
    );
    expect(gatewayHostRefusal("api.northwind.io", hosts)).toBeNull();
    // A sibling of the base domain is someone else's.
    expect(gatewayHostRefusal("example.com", hosts)).toBeNull();
  });

  it("takes the gateway as a URL too, and refuses nothing it isn't told", () => {
    expect(
      gatewayHostRefusal("gw.example.org", {
        gatewayHost: "https://GW.example.org/",
      }),
    ).toBe("gw.example.org is this gateway's own host");
    expect(gatewayHostRefusal("apps.example.com", {})).toBeNull();
  });
});

describe("an ai row in the registry", () => {
  const vendor = {
    id: "vendor-ai",
    mode: "ai",
    name: "Vendor AI",
    docs: "https://vendor.example/keys",
    baseUrl: "https://api.vendor.example/openai",
    auth: { kind: "bearer", secret: "VENDOR_AI_API_KEY" },
    models: ["v-chat", "v-embed"],
    defaultModel: "v-chat",
    embeddingsModel: "v-embed",
  };

  it("is served as an ai entry, with its key bound to its base URL and auth, and its host under the host rules", () => {
    const registry = providerRegistry([{ id: "vendor-ai", spec: vendor }]);
    const capability = registry.get("vendor-ai");
    expect(capability?.mode).toBe("ai");
    expect(registry.settingNames().has("VENDOR_AI_API_KEY")).toBe(true);
    expect(registry.bound("vendor-ai")).toBe(false);
    const [row] = registry.rows();
    const key = providerBindingKey(row!.capability);
    expect(JSON.parse(key)).toEqual({
      kind: "ai",
      auth: { kind: "bearer", secret: "VENDOR_AI_API_KEY" },
      origin: "https://api.vendor.example",
      basePath: "/openai",
    });
    const bound = providerRegistry([
      { id: "vendor-ai", spec: vendor, boundTo: key },
    ]);
    expect(bound.bound("vendor-ai")).toBe(true);
    // Another base path is another key.
    const moved = providerRegistry([
      {
        id: "vendor-ai",
        spec: { ...vendor, baseUrl: "https://api.vendor.example/v2" },
        boundTo: key,
      },
    ]);
    expect(moved.bound("vendor-ai")).toBe(false);
    expect(registrableHosts(row!.capability)).toEqual(["api.vendor.example"]);
    const refused = providerRegistry([{ id: "vendor-ai", spec: vendor }], {
      refuseHost: (host) =>
        host === "api.vendor.example"
          ? `${host} is this gateway's own host`
          : null,
    });
    expect(refused.rejected.map((r) => r.code)).toEqual([
      "PROVIDER_HOST_REFUSED",
    ]);
    // Its setting must carry its id, like any row's.
    const taken = providerRegistry([
      {
        id: "vendor-ai",
        spec: { ...vendor, auth: { kind: "bearer", secret: "OPENAI_API_KEY" } },
      },
    ]);
    expect(taken.rejected.map((r) => r.code)).toEqual([
      "PROVIDER_SECRET_TAKEN",
    ]);
  });

  it("is a default-model candidate only once its key is bound", () => {
    const registry = providerRegistry([{ id: "vendor-ai", spec: vendor }]);
    const isSet = (name: string) => name === "VENDOR_AI_API_KEY";
    const unbound = aiDefaultCandidates(isSet, registry).find(
      (c) => c.id === "vendor-ai",
    );
    expect(unbound).toMatchObject({ id: "vendor-ai", configured: false });
    const key = providerBindingKey(registry.rows()[0]!.capability);
    const bound = providerRegistry([
      { id: "vendor-ai", spec: vendor, boundTo: key },
    ]);
    expect(
      aiDefaultCandidates(isSet, bound).find((c) => c.id === "vendor-ai"),
    ).toMatchObject({ configured: true });
    expect(
      resolveAiDefault({
        provider: "vendor-ai",
        isSet,
        lookup: bound,
      }),
    ).toMatchObject({
      provider: "vendor-ai",
      model: "v-chat",
      configured: true,
    });
  });
});
