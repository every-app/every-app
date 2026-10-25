import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
} from "./capabilities";
import {
  BUILTIN_PROVIDERS,
  providerRegistry,
  providerSettingPrefix,
  publicHostProblem,
  rowSecretProblem,
} from "./providerRegistry";

const stripe = {
  id: "stripe",
  spec: {
    id: "stripe",
    name: "Stripe",
    docs: "https://dashboard.stripe.com/apikeys",
    hosts: ["api.stripe.com"],
    auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
  },
};

describe("the built-in registry", () => {
  it("is the catalog, in catalog order, with every setting it reads", () => {
    expect(BUILTIN_PROVIDERS.ids()).toEqual(CAPABILITY_IDS);
    expect(BUILTIN_PROVIDERS.sourceOf("dataforseo")).toBe("catalog");
    expect(BUILTIN_PROVIDERS.sourceOf("stripe")).toBeUndefined();
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
      stripe,
      {
        id: "exa",
        spec: JSON.stringify({
          ...stripe.spec,
          id: "exa",
          name: "Exa",
          hosts: ["api.exa.ai"],
          auth: { kind: "header", secret: "EXA_API_KEY", header: "x-api-key" },
        }),
      },
    ]);
    expect(registry.rejected).toEqual([]);
    expect(registry.ids()).toEqual([...CAPABILITY_IDS, "stripe", "exa"]);
    expect(registry.sourceOf("stripe")).toBe("row");
    expect(registry.get("stripe")).toMatchObject({
      mode: "api_key",
      label: "Stripe",
    });
    expect(registry.settingNames().has("STRIPE_API_KEY")).toBe(true);
    expect(registry.settingNames().has("EXA_API_KEY")).toBe(true);
  });

  it("never lets a row shadow the catalog or take the reserved id", () => {
    const registry = providerRegistry([
      {
        id: "dataforseo",
        spec: {
          ...stripe.spec,
          id: "dataforseo",
          auth: { kind: "bearer", secret: "DATAFORSEO_OTHER" },
        },
      },
      {
        id: "everyapp",
        spec: {
          ...stripe.spec,
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
          ...stripe.spec,
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
      stripe,
      {
        id: "stripe-eu",
        spec: {
          ...stripe.spec,
          id: "stripe-eu",
          hosts: ["api.stripe.com"],
          auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
        },
      },
    ]);
    expect(registry.get("stripe")).toBeDefined();
    expect(registry.rejected).toEqual([
      {
        id: "stripe-eu",
        code: "PROVIDER_SECRET_TAKEN",
        message:
          "STRIPE_API_KEY doesn't start with STRIPE_EU_: a provider's settings carry its own id",
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
    expect(publicHostProblem("api.stripe.com")).toBeNull();
    const registry = providerRegistry(
      [
        {
          id: "aa",
          spec: {
            ...stripe.spec,
            id: "aa",
            hosts: ["10.0.0.1"],
            auth: { kind: "bearer", secret: "AA_KEY" },
          },
        },
        {
          id: "bb",
          spec: {
            ...stripe.spec,
            id: "bb",
            hosts: ["crm.apps.example.com"],
            auth: { kind: "bearer", secret: "BB_KEY" },
          },
        },
        {
          id: "cc",
          spec: {
            ...stripe.spec,
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
          ...stripe.spec,
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
