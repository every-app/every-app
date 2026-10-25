/**
 * The strict validator against a provider registry: a capability id the
 * lookup has is checked as a catalog entry is; one it doesn't is refused,
 * or accepted (access and need only) for the gateway to check; an AI
 * provider under `capabilities` is refused with the fix.
 */
import { providerRegistry } from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import { capabilityEntrySchema, validateManifestStrict } from "./manifest";

const stripe = {
  id: "stripe",
  spec: {
    id: "stripe",
    name: "Stripe",
    docs: "https://dashboard.stripe.com/apikeys",
    hosts: ["api.stripe.com"],
    auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
    access: ["read"],
  },
};
const registry = providerRegistry([stripe]);

describe("the strict validator and the provider registry", () => {
  it("refuses an id the catalog doesn't have, naming the catalog's capabilities and no AI provider", () => {
    expect(() =>
      validateManifestStrict({
        id: "shop",
        capabilities: { stripe: { access: "read" } },
      }),
    ).toThrow(
      /capabilities\.stripe: unknown capability \(the gateway offers: dataforseo, context, email, members, linkedin/,
    );
    expect(() =>
      validateManifestStrict({
        id: "shop",
        capabilities: { stripe: { access: "read" } },
      }),
    ).not.toThrow(/openrouter/);
  });

  it("accepts a registered provider's entry through its registry, checking the access it offers", () => {
    expect(
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { stripe: { access: "read", why: "Charges." } },
        },
        { capabilities: registry },
      ).capabilities,
    ).toEqual({ stripe: { access: "read", why: "Charges." } });
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { stripe: { access: "write" } } },
        { capabilities: registry },
      ),
    ).toThrow(/capabilities\.stripe\.access: Stripe offers read access/);
    expect(() =>
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { stripe: { access: "read", scopes: ["x"] } },
        },
        { capabilities: registry },
      ),
    ).toThrow(/Stripe takes no scopes/);
    // Still refuses one nobody has.
    expect(() =>
      validateManifestStrict(
        { id: "shop", capabilities: { square: { access: "read" } } },
        { capabilities: registry },
      ),
    ).toThrow(
      /capabilities\.square: unknown capability \(the gateway offers: .*stripe\)/,
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
    expect(() =>
      validateManifestStrict(
        {
          id: "shop",
          capabilities: { square: { access: "read", scopes: ["x"] } },
        },
        options,
      ),
    ).toThrow(
      /capabilities\.square\.scopes: a provider registered on the gateway takes no scopes/,
    );
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
        { id: "shop", secrets: ["STRIPE_API_KEY"] },
        { capabilities: registry },
      ),
    ).toThrow(
      "Invalid everyapp.config: secrets.0: STRIPE_API_KEY is a Gateway setting, which `everyapp secret set STRIPE_API_KEY` sets on the Gateway for every app; list `stripe` under capabilities instead",
    );
    // Without the registry the name is the app's to hold.
    expect(
      validateManifestStrict({ id: "shop", secrets: ["STRIPE_API_KEY"] })
        .secrets,
    ).toEqual(["STRIPE_API_KEY"]);
    // A catalog key is refused as before, with or without it.
    expect(() =>
      validateManifestStrict(
        { id: "shop", secrets: [{ name: "openai_api_key" }] },
        { capabilities: registry },
      ),
    ).toThrow(/list `openai` under providers instead/);
  });

  it("builds an entry schema only for a capability the lookup has", () => {
    expect(() => capabilityEntrySchema("stripe")).toThrow(/not a capability/);
    expect(() => capabilityEntrySchema("openrouter")).toThrow(
      /not a capability/,
    );
    expect(
      capabilityEntrySchema("stripe", registry).safeParse({ access: "read" })
        .success,
    ).toBe(true);
  });
});
