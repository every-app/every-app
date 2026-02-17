import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGateway, getGatewayUrl } from "./gateway";

type TestFetcher = {
  fetch: ReturnType<typeof vi.fn>;
};

type TestEnv = {
  GATEWAY_URL?: string;
  EVERY_APP_GATEWAY?: TestFetcher;
  GATEWAY_APP_API_TOKEN?: string;
  APP_TOKEN?: string;
};

describe("gateway server helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns gateway URL and throws when missing", () => {
    expect(getGatewayUrl({ GATEWAY_URL: "https://gateway.example.com" })).toBe(
      "https://gateway.example.com",
    );

    expect(() => getGatewayUrl({} as TestEnv)).toThrow(
      "GATEWAY_URL is required",
    );
  });

  it("fetches via HTTP when service binding is unavailable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
      GATEWAY_APP_API_TOKEN: "eat_test_token",
    };

    await fetchGateway({
      env,
      url: "/api/ai/openai/v1/responses?stream=true",
      init: { method: "POST" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestArg] = fetchMock.mock.calls[0];
    const request = requestArg as Request;

    expect(request.url).toBe(
      "https://gateway.example.com/api/ai/openai/v1/responses?stream=true",
    );
  });

  it("fetches via service binding when available", async () => {
    const bindingFetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
      EVERY_APP_GATEWAY: { fetch: bindingFetch },
      GATEWAY_APP_API_TOKEN: "eat_test_token",
    };

    await fetchGateway({
      env,
      url: "/api/ai/openai/v1/chat/completions",
      init: { method: "POST" },
    });

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    const [requestArg] = bindingFetch.mock.calls[0];
    const request = requestArg as Request;
    expect(request.url).toBe(
      "http://localhost/api/ai/openai/v1/chat/completions",
    );
  });

  it("always injects app token and strips Authorization header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
      GATEWAY_APP_API_TOKEN: "eat_my_token",
    };

    await fetchGateway({
      env,
      url: "/api/ai/openai/v1/responses",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer some-sdk-dummy-value",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestArg] = fetchMock.mock.calls[0];
    const request = requestArg as Request;

    expect(request.headers.get("x-every-app-token")).toBe("eat_my_token");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("throws when app token is missing", async () => {
    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
    };

    await expect(
      fetchGateway({
        env,
        url: "/api/ai/openai/v1/responses",
      }),
    ).rejects.toThrow("GATEWAY_APP_API_TOKEN is required");
  });

  it("supports legacy APP_TOKEN env variable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
      APP_TOKEN: "eat_legacy_token",
    };

    await fetchGateway({
      env,
      url: "/api/ai/openai/v1/responses",
      init: { method: "POST" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestArg] = fetchMock.mock.calls[0];
    const request = requestArg as Request;

    expect(request.headers.get("x-every-app-token")).toBe("eat_legacy_token");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("supports Request input and preserves method/body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const env: TestEnv = {
      GATEWAY_URL: "https://gateway.example.com",
      GATEWAY_APP_API_TOKEN: "eat_test_token",
    };

    const sourceRequest = new Request(
      "https://gateway.example.com/api/ai/openai/v1/responses",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.2" }),
        headers: { "content-type": "application/json" },
      },
    );

    await fetchGateway({
      env,
      url: sourceRequest,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestArg] = fetchMock.mock.calls[0];
    const request = requestArg as Request;
    expect(request.url).toBe(
      "https://gateway.example.com/api/ai/openai/v1/responses",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
  });
});
