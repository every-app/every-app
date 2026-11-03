import { describe, expect, it } from "vitest";
import { parseProviderSpec } from "@every-app/sdk/internal";
import { customSpecOf, slugOf } from "@/client/lib/oauthProviders";

describe("slugOf", () => {
  it("makes a provider id from a name", () => {
    expect(slugOf("Acme Cloud")).toBe("acme-cloud");
    expect(slugOf("  42 Things!! ")).toBe("things");
    expect(slugOf("x".repeat(60))).toHaveLength(40);
  });
});

describe("customSpecOf", () => {
  it("builds a spec the registry's parser accepts, with the id's setting names and no scopes", () => {
    const spec = customSpecOf({
      name: "Acme Cloud",
      id: "acme-cloud",
      console: "https://console.acme.com/apps",
      authorizeUrl: "https://acme.com/oauth/authorize",
      tokenUrl: "https://acme.com/oauth/token",
      hosts: "api.acme.com, Files.acme.com",
      scopeSeparator: "comma",
      inject: "basic",
      pkce: false,
    });
    expect(spec).toMatchObject({
      id: "acme-cloud",
      hosts: ["api.acme.com", "files.acme.com"],
      auth: {
        kind: "oauth2-user",
        clientId: "ACME_CLOUD_CLIENT_ID",
        clientSecret: "ACME_CLOUD_CLIENT_SECRET",
        inject: "basic",
        pkce: false,
        scopeSeparator: "comma",
      },
    });
    expect(spec).not.toHaveProperty("scopeSets");
    expect(spec).not.toHaveProperty("access");
    const parsed = parseProviderSpec(spec);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });
});
