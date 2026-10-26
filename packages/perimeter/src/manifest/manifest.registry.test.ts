/**
 * The strict validator against a provider registry: a capability id the
 * lookup has is checked as a catalog entry is; one it doesn't is refused,
 * or accepted (access and need only) for the gateway to check; an AI
 * provider under `capabilities` is refused with the fix.
 */
import { providerRegistry } from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import { capabilityEntrySchema, validateManifestStrict } from "./manifest";

const northwind = {
  id: "northwind",
  spec: {
    id: "northwind",
    name: "Northwind",
    docs: "https://developer.northwind.io/keys",
    hosts: ["api.northwind.io"],
    auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
    access: ["read"],
  },
};
const registry = providerRegistry([northwind]);

describe("the strict validator and the provider registry", () => {
  it("refuses an id the catalog doesn't have, naming the catalog's capabilities and no AI provider", () => {
    expect(() =>
      validateManifestStrict({
        id: "shop",
        capabilities: { northwind: { access: "read" } },
      }),
    ).toThrow(
      /capabilities\.northwind: unknown capability \(the gateway offers: dataforseo, context, email, members, slack, google-workspace/,
    );
    expect(() =>
      validateManifestStrict({
        id: "shop",
        capabilities: { northwind: { access: "read" } },
      }),
    ).not.toThrow(/openrouter/);
  });

  it("accepts a registered provider's entry through its registry, checking the access it offers", () => {
    expect(
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { northwind: { access: "read", why: "Charges." } },
        },
        { capabilities: registry },
      ).capabilities,
    ).toEqual({ northwind: { access: "read", why: "Charges." } });
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { northwind: { access: "write" } } },
        { capabilities: registry },
      ),
    ).toThrow(/capabilities\.northwind\.access: Northwind offers read access/);
    expect(() =>
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { northwind: { access: "read", scopes: ["x"] } },
        },
        { capabilities: registry },
      ),
    ).toThrow(/Northwind takes no scopes/);
    // Still refuses one nobody has.
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { square: { access: "read" } } },
        { capabilities: registry },
      ),
    ).toThrow(
      /capabilities\.square: unknown capability \(the gateway offers: .*northwind\)/,
    );
  });

  it("accepts a well-formed unknown entry when told to, for the gateway to check later", () => {
    const options = { unknownCapabilities: "accept" as const };
    expect(
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { square: { access: "write", why: "Orders." } },
        },
        options,
      ).capabilities,
    ).toEqual({ square: { access: "write", why: "Orders." } });
    // A registered OAuth provider's scope sets pass as well-formed names;
    // the gateway's registry says whether the provider has them.
    expect(
      validateManifestStrict(
        {
          id: "shop",
          capabilities: {
            square: { access: "read", scopes: ["identity", "orders.read"] },
          },
        },
        options,
      ).capabilities,
    ).toEqual({
      square: { access: "read", scopes: ["identity", "orders.read"] },
    });
    expect(() =>
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { square: { access: "read", scopes: ["Orders Read"] } },
        },
        options,
      ),
    ).toThrow(/capabilities\.square\.scopes\.0: a scope set is named identity/);
    expect(() =>
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { square: { access: "read", scopes: [] } },
        },
        options,
      ),
    ).toThrow(/capabilities\.square\.scopes: scopes lists at least one set/);
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { square: { access: "admin" } } },
        options,
      ),
    ).toThrow(/capabilities\.square\.access/);
    // A catalog entry is still checked as itself.
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { dataforseo: { access: "write" } } },
        options,
      ),
    ).toThrow(/DataForSEO offers read access/);
  });

  it("refuses an AI provider under capabilities, pointing at providers", () => {
    for (const options of [
      undefined,
      { unknownCapabilities: "accept" as const },
      { capabilities: registry },
    ]) {
      expect(() =>
        validateManifestStrict(
          { id: "shop", capabilities: { openrouter: { access: "read" } } },
          options,
        ),
      ).toThrow(
        /capabilities\.openrouter: openrouter is an AI provider: list it under providers, not capabilities/,
      );
    }
  });

  it("refuses an app secret a registered provider holds, in the words it refuses a catalog key in", () => {
    expect(() =>
      validateManifestStrict(
        { id: "shop", secrets: ["NORTHWIND_API_KEY"] },
        { capabilities: registry },
      ),
    ).toThrow(
      "Invalid everyapp.config: secrets.0: NORTHWIND_API_KEY is a Gateway setting, which `everyapp secret set NORTHWIND_API_KEY` sets on the Gateway for every app; list `northwind` under capabilities instead",
    );
    // Without the registry the name is the app's to hold.
    expect(
      validateManifestStrict({ id: "shop", secrets: ["NORTHWIND_API_KEY"] })
        .secrets,
    ).toEqual(["NORTHWIND_API_KEY"]);
    // A catalog key is refused as before, with or without it.
    expect(() =>
      validateManifestStrict(
        { id: "shop", secrets: [{ name: "openai_api_key" }] },
        { capabilities: registry },
      ),
    ).toThrow(/list `openai` under providers instead/);
  });

  it("builds an entry schema only for a capability the lookup has", () => {
    expect(() => capabilityEntrySchema("northwind")).toThrow(
      /not a capability/,
    );
    expect(() => capabilityEntrySchema("openrouter")).toThrow(
      /not a capability/,
    );
    expect(
      capabilityEntrySchema("northwind", registry).safeParse({ access: "read" })
        .success,
    ).toBe(true);
  });
});
