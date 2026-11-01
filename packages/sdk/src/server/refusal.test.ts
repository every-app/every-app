import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../internal/index";
import { ai } from "./ai";
import { createGatewayFetch } from "./gatewayFetch";
import {
  GatewayRefusalError,
  gatewayRefusal,
  isAiNotConfigured,
  refusalFromError,
} from "./refusal";

/** Background work for one organization: no request context needed. */
const FOR = { background: true, organizationId: "org-1" } as const;

const SETUP =
  "OpenRouter isn't set up on this Gateway: it needs OPENROUTER_API_KEY. An admin runs: pnpm everyapp configure inbox";

/** The AI proxy's refusal body: OpenAI's error shape, the fields at both levels. */
const AI_BODY = {
  error: {
    message: SETUP,
    code: "ai_provider_not_configured",
    type: "gateway_refusal",
    settings: ["OPENROUTER_API_KEY"],
    setup: SETUP,
    command: "pnpm everyapp configure inbox",
  },
  code: "ai_provider_not_configured",
  message: SETUP,
  settings: ["OPENROUTER_API_KEY"],
  setup: SETUP,
  command: "pnpm everyapp configure inbox",
};

const EXPECTED = {
  status: 503,
  code: "ai_provider_not_configured",
  message: SETUP,
  settings: ["OPENROUTER_API_KEY"],
  setup: SETUP,
  command: "pnpm everyapp configure inbox",
};

/** ai-sdk's APICallError, as far as its fields go. */
class APICallError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseHeaders: Record<string, string>,
    readonly responseBody: string,
  ) {
    super("Service Unavailable");
  }
}

/** An OpenAI SDK APIError (v5): `headers` a Headers, `error` the body's `error`. */
class APIError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly error: unknown,
  ) {
    super(`${status} ${JSON.stringify(error)}`);
  }
}

describe("gatewayRefusal", () => {
  it("reads the settings, sentence and command a not-set-up refusal carries", async () => {
    const response = Response.json(AI_BODY, {
      status: 503,
      headers: { "x-everyapp-error": "ai_provider_not_configured" },
    });
    await expect(gatewayRefusal(response)).resolves.toEqual(EXPECTED);
  });
});

describe("refusalFromError", () => {
  it("reads ai-sdk's APICallError, by its header and body", () => {
    const error = new APICallError(
      503,
      { "x-everyapp-error": "ai_provider_not_configured" },
      JSON.stringify(AI_BODY),
    );
    expect(refusalFromError(error)).toEqual(EXPECTED);
    expect(isAiNotConfigured(error)).toBe(true);
  });

  it("reads an OpenAI SDK APIError, whose error is the body's error object", () => {
    const error = new APIError(
      503,
      new Headers({ "x-everyapp-error": "ai_provider_not_configured" }),
      AI_BODY.error,
    );
    expect(refusalFromError(error)).toEqual(EXPECTED);
  });

  it("finds the refusal inside ai-sdk's RetryError and an error's cause", () => {
    const refused = new APICallError(
      503,
      { "x-everyapp-error": "ai_default_not_configured" },
      JSON.stringify({ ...AI_BODY, code: "ai_default_not_configured" }),
    );
    const retry = Object.assign(new Error("Failed after 3 attempts"), {
      lastError: refused,
    });
    expect(refusalFromError(retry)?.code).toBe("ai_default_not_configured");
    expect(isAiNotConfigured(new Error("wrapped", { cause: retry }))).toBe(
      true,
    );
  });

  it("passes a GatewayRefusalError's fields through", () => {
    const error = new GatewayRefusalError({
      status: 503,
      code: "integration_not_configured",
      message: "Email isn't set up on this Gateway.",
      settings: ["EMAIL_FROM", "EMAIL_FROM_NAME"],
      setup: "Email isn't set up on this Gateway.",
      command: "pnpm everyapp configure inbox",
    });
    expect(refusalFromError(error)).toMatchObject({
      code: "integration_not_configured",
      settings: ["EMAIL_FROM", "EMAIL_FROM_NAME"],
      command: "pnpm everyapp configure inbox",
    });
    expect(isAiNotConfigured(error)).toBe(false);
  });

  it("answers local development's missing key as the deployed refusal would", () => {
    let thrown: unknown;
    try {
      createGatewayFetch({ env: { EVERYAPP_DEV: "1" }, for: FOR });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect(isAiNotConfigured(thrown)).toBe(true);
    expect(refusalFromError(thrown)).toMatchObject({
      status: 503,
      code: "ai_provider_not_configured",
      command: null,
    });
  });

  it("names the default's key when the default can't resolve in local development", async () => {
    // Cohere's key reaches Cohere, but Cohere is never the default.
    const client = ai({
      env: { EVERYAPP_DEV: "1", COHERE_API_KEY: "co" },
      for: FOR,
    });
    const error = await client
      .fetch(client.chatCompletionsUrl, { method: "POST" })
      .catch((caught: unknown) => caught);
    expect(isAiNotConfigured(error)).toBe(true);
    expect(refusalFromError(error)).toMatchObject({
      code: "ai_default_not_configured",
      settings: ["OPENROUTER_API_KEY"],
    });
  });

  it("is null for anything else", () => {
    expect(refusalFromError(new Error("boom"))).toBeNull();
    expect(refusalFromError(new ConfigurationError("bad binding"))).toBeNull();
    expect(
      refusalFromError(new APICallError(500, {}, '{"error":"provider"}')),
    ).toBeNull();
    expect(refusalFromError("text")).toBeNull();
    expect(refusalFromError(new Response("x", { status: 503 }))).toBeNull();
    expect(isAiNotConfigured(undefined)).toBe(false);
  });
});
