import { describe, expect, it } from "vitest";
import { appSettings, providerLabel } from "./appSettings";
import { providerRegistry } from "./providerRegistry";

const registry = providerRegistry([
  {
    id: "stripe",
    spec: {
      id: "stripe",
      name: "Stripe",
      docs: "https://dashboard.stripe.com/apikeys",
      hosts: ["api.stripe.com"],
      auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
      hint: "A restricted key from the dashboard.",
      secrets: [
        { name: "STRIPE_API_KEY", hint: "Read access to Customers is enough." },
      ],
    },
  },
  {
    id: "twilio",
    spec: {
      id: "twilio",
      name: "Twilio",
      docs: "https://console.twilio.com/",
      hosts: ["api.twilio.com"],
      auth: {
        kind: "basic",
        secret: "TWILIO_AUTH_TOKEN",
        as: "password",
        user: { secret: "TWILIO_ACCOUNT_SID" },
      },
      secrets: [
        { name: "TWILIO_ACCOUNT_SID", hint: "Starts with AC." },
        { name: "TWILIO_AUTH_TOKEN", hint: "From the console's account page." },
      ],
    },
  },
]);

describe("the settings model and the provider registry", () => {
  it("reads a registered provider's setting, with its hint, through the lookup it is given", () => {
    const manifest = {
      capabilities: {
        stripe: { access: "read", why: "Shows charges." },
        twilio: { access: "read", optional: true },
      },
    };
    // The catalog alone knows neither.
    expect(appSettings(manifest)).toEqual([]);
    expect(appSettings(manifest, registry)).toEqual([
      {
        kind: "capability",
        id: "stripe",
        label: "Stripe",
        holder: "gateway",
        names: ["STRIPE_API_KEY"],
        alsoReads: [],
        need: { kind: "required" },
        why: "Shows charges.",
        docs: "https://dashboard.stripe.com/apikeys",
        hint: "A restricted key from the dashboard. Read access to Customers is enough.",
      },
      {
        kind: "capability",
        id: "twilio",
        label: "Twilio",
        holder: "gateway",
        names: ["TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID"],
        alsoReads: [],
        need: { kind: "optional" },
        docs: "https://console.twilio.com/",
        // Several names: each hint carries its name, in the entry's order.
        hint: "TWILIO_ACCOUNT_SID: Starts with AC. TWILIO_AUTH_TOKEN: From the console's account page.",
      },
    ]);
    expect(providerLabel("stripe", registry)).toBe("Stripe");
    expect(providerLabel("stripe")).toBe("stripe");
  });

  it("gives the catalog's entries their hints too, and an AI provider its label under providers only", () => {
    const [dataforseo] = appSettings({
      capabilities: { dataforseo: { access: "read" } },
    });
    expect(dataforseo).toMatchObject({
      label: "DataForSEO",
      setup: "setup/dataforseo.md",
      hint: "The API login and password from API Access, as login:password (or that pair base64-encoded); the Gateway sends them as HTTP Basic. login:password, or its base64; never the dashboard sign-in password.",
    });
    expect(appSettings({ providers: ["openrouter"] })).toEqual([
      {
        kind: "provider",
        id: "openrouter",
        label: "OpenRouter",
        holder: "gateway",
        names: ["OPENROUTER_API_KEY"],
        alsoReads: [],
        need: { kind: "required" },
        docs: "https://openrouter.ai/settings/keys",
        setup: "setup/openrouter.md",
        hint: "An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.",
      },
    ]);
    // Workers AI's account is the install's: never asked for.
    expect(appSettings({ providers: ["workers-ai"] })[0]).toMatchObject({
      names: ["WORKERS_AI_API_TOKEN"],
    });
    // Under `capabilities`, an AI provider is the validator's to refuse; here it is nothing.
    expect(
      appSettings({ capabilities: { openrouter: { access: "read" } } }),
    ).toEqual([]);
  });
});
