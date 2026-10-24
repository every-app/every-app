import { describe, expect, it } from "vitest";
import { devGatewaySettingsFor } from "./devGatewaySettings";

describe("devGatewaySettingsFor", () => {
  it("lists what .dev.vars stands in for, in order, once, required only where the dev fallback can't do without", () => {
    expect(
      devGatewaySettingsFor({
        providers: ["workers-ai", "openai"],
        capabilities: {
          email: { access: "write" },
          mastodon: { access: "write" },
          dataforseo: { access: "read" },
        },
      }),
    ).toEqual([
      { name: "WORKERS_AI_API_TOKEN", required: true },
      // The dev fallback builds Workers AI's URL from the account id; the
      // Gateway's view leaves it out as the install's.
      { name: "CLOUDFLARE_ACCOUNT_ID", required: true },
      { name: "OPENAI_API_KEY", required: true },
      // Email's sender and transports: sendEmail() prints without them.
      { name: "EMAIL_FROM", required: false },
      { name: "EMAIL_FROM_NAME", required: false },
      { name: "EMAIL_REST_API_TOKEN", required: false },
      { name: "RESEND_API_KEY", required: false },
      { name: "EMAIL_PROVIDER", required: false },
      { name: "MASTODON_CLIENT_ID", required: true },
      { name: "MASTODON_CLIENT_SECRET", required: true },
      // The instance has a default.
      { name: "MASTODON_URL", required: false },
      { name: "DATAFORSEO_API_KEY", required: true },
    ]);
  });

  it("leaves a service's settings optional, the account id among them when email alone names it", () => {
    expect(
      devGatewaySettingsFor({
        capabilities: {
          email: { access: "write" },
          members: { access: "read" },
        },
      }),
    ).toEqual([
      { name: "EMAIL_FROM", required: false },
      { name: "EMAIL_FROM_NAME", required: false },
      { name: "EMAIL_REST_API_TOKEN", required: false },
      { name: "CLOUDFLARE_ACCOUNT_ID", required: false },
      { name: "RESEND_API_KEY", required: false },
      { name: "EMAIL_PROVIDER", required: false },
    ]);
  });

  it("reads a provider entry given as an object by its id", () => {
    expect(
      devGatewaySettingsFor({
        providers: ["openai", { id: "openrouter" }],
      }),
    ).toEqual([
      { name: "OPENAI_API_KEY", required: true },
      { name: "OPENROUTER_API_KEY", required: true },
    ]);
  });

  it("is empty for a manifest that uses nothing, or names what the gateway doesn't offer", () => {
    expect(devGatewaySettingsFor({})).toEqual([]);
    expect(
      devGatewaySettingsFor({
        providers: ["anthropic", { id: "anthropic" }],
        capabilities: { github: { access: "read" } },
      }),
    ).toEqual([]);
  });
});
