import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ConfigurationError } from "../internal/index";
import { ai, aiBaseUrl, providerBaseUrl, type AiClient } from "./ai";
import { createGatewayFetch } from "./gatewayFetch";
import { integrationFetch } from "./integrationFetch";

/** Background work for one organization: no request context needed. */
const FOR = { background: true, organizationId: "org-1" } as const;

describe("aiBaseUrl and providerBaseUrl", () => {
  it("name the default route and each provider's OpenAI-compatible base", () => {
    expect(aiBaseUrl()).toBe(
      "http://every-app-gateway.internal/api/ai/default/v1",
    );
    expect(aiBaseUrl("openrouter")).toBe(
      "http://every-app-gateway.internal/api/ai/openrouter/api/v1",
    );
    expect(aiBaseUrl("workers-ai")).toBe(
      "http://every-app-gateway.internal/api/ai/workers-ai/v1",
    );
    expect(aiBaseUrl("openai")).toBe(
      "http://every-app-gateway.internal/api/ai/openai/v1",
    );
  });

  it("point a provider with no OpenAI-compatible chat route at its root", () => {
    expect(() => aiBaseUrl("cohere")).toThrow(ConfigurationError);
    expect(() => aiBaseUrl("nope")).toThrow(/providerBaseUrl\("nope"\)/);
    expect(providerBaseUrl("cohere")).toBe(
      "http://every-app-gateway.internal/api/ai/cohere",
    );
  });

  it("reach the provider over the binding with the Gateway fetch", async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({}));
    const gateway = createGatewayFetch({
      for: FOR,
      env: { EVERY_APP_GATEWAY: { fetch } },
    });
    await gateway(`${aiBaseUrl("openrouter")}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    expect(fetch.mock.calls[0]![0].url).toBe(
      "http://every-app-gateway.internal/api/ai/openrouter/api/v1/chat/completions",
    );
  });
});

describe("{ optional: true }", () => {
  const unavailable = { EVERYAPP_DEV: "1" };

  it("answers null instead of throwing when AI is unavailable", () => {
    expect(() => createGatewayFetch({ for: FOR, env: unavailable })).toThrow(
      ConfigurationError,
    );
    expect(
      createGatewayFetch({ for: FOR, env: unavailable, optional: true }),
    ).toBeNull();
    expect(ai({ for: FOR, env: unavailable, optional: true })).toBeNull();
    expectTypeOf(
      ai({ for: FOR, env: unavailable, optional: true }),
    ).toEqualTypeOf<AiClient | null>();
    const strict = () => ai({ for: FOR, env: unavailable });
    expectTypeOf(strict).returns.toEqualTypeOf<AiClient>();
    expect(
      ai({
        for: FOR,
        env: { ...unavailable, OPENAI_API_KEY: "sk" },
        optional: true,
      })?.baseURL,
    ).toBe(aiBaseUrl());
  });

  it("answers null for an integration without its settings", () => {
    expect(() =>
      integrationFetch({ for: FOR, env: unavailable, provider: "dataforseo" }),
    ).toThrow(ConfigurationError);
    expect(
      integrationFetch({
        for: FOR,
        env: unavailable,
        provider: "dataforseo",
        optional: true,
      }),
    ).toBeNull();
    expect(
      integrationFetch({
        for: FOR,
        env: { ...unavailable, DATAFORSEO_API_KEY: "login:pass" },
        provider: "dataforseo",
        optional: true,
      }),
    ).toBeTypeOf("function");
  });

  it("still throws for a binding that isn't one", () => {
    expect(() =>
      createGatewayFetch({
        for: FOR,
        env: { EVERY_APP_GATEWAY: "nope" },
        optional: true,
      }),
    ).toThrow(/not a valid service binding/);
  });
});
