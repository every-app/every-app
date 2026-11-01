/**
 * A registered `ai` row (an OpenAI-compatible spec, `mode: "ai"`) through
 * the AI proxy: served from the registry exactly as a catalog entry is
 * (inference POSTs on its routes at its base URL, the key placed as its
 * auth says, `store: false` on chat), its key read only while the row is
 * bound (`providers.value-bound-to-hosts`), and only the models its spec
 * lists.
 */
import { describe, expect, it, vi } from "vitest";
import { providerBindingKey, providerRegistry } from "@every-app/sdk/internal";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";

const ORIGIN = "http://every-app-gateway.internal";
const VENDOR = {
  id: "vendor-ai",
  mode: "ai",
  name: "Vendor AI",
  docs: "https://vendor.example/keys",
  baseUrl: "https://api.vendor.example/openai",
  auth: { kind: "header", secret: "VENDOR_AI_API_KEY", header: "x-vendor-key" },
  models: ["v-chat", "v-embed"],
  defaultModel: "v-chat",
  embeddingsModel: "v-embed",
};
const ENV = { VENDOR_AI_API_KEY: "vendor-secret" };

function registry(bound = true) {
  const unbound = providerRegistry([{ id: "vendor-ai", spec: VENDOR }]);
  if (!bound) return unbound;
  return providerRegistry([
    {
      id: "vendor-ai",
      spec: VENDOR,
      boundTo: providerBindingKey(unbound.rows()[0]!.capability),
    },
  ]);
}

async function call(
  path: string,
  body: unknown,
  lookup = registry(),
  env: Record<string, string> = ENV,
) {
  const fetchUpstream = vi.fn(async (_request: Request) =>
    Response.json({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  const response = await handleAuthenticatedAiProxyRequest({
    request: new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    provider: "vendor-ai",
    env,
    lookup,
    fetchUpstream,
  });
  return { response, upstream: fetchUpstream.mock.calls[0]?.[0] };
}

describe("a registered ai row through the AI proxy", () => {
  it("forwards an inference POST to the row's base URL with the key where its auth says, and store: false on chat", async () => {
    const { response, upstream } = await call(
      "/api/ai/vendor-ai/v1/chat/completions",
      { model: "v-chat", messages: [] },
    );
    expect(response.status).toBe(200);
    expect(upstream?.url).toBe(
      "https://api.vendor.example/openai/v1/chat/completions",
    );
    expect(upstream?.headers.get("x-vendor-key")).toBe("vendor-secret");
    expect(upstream?.headers.get("authorization")).toBeNull();
    expect(JSON.parse(await upstream!.text())).toEqual({
      model: "v-chat",
      messages: [],
      store: false,
    });
  });

  it("refuses anything but its inference routes, a model it doesn't serve, and an unbound row", async () => {
    const files = await call("/api/ai/vendor-ai/v1/files", {});
    expect(files.response.status).toBe(403);
    expect(files.upstream).toBeUndefined();
    const other = await call("/api/ai/vendor-ai/v1/chat/completions", {
      model: "gpt-6",
      messages: [],
    });
    expect(other.response.status).toBe(403);
    await expect(other.response.json()).resolves.toMatchObject({
      code: "model_not_allowed",
      error: {
        message:
          "vendor-ai doesn't serve this model (gpt-6); its spec lists: v-chat, v-embed.",
      },
    });
    const unbound = await call(
      "/api/ai/vendor-ai/v1/chat/completions",
      { model: "v-chat", messages: [] },
      registry(false),
    );
    expect(unbound.response.status).toBe(503);
    await expect(unbound.response.json()).resolves.toMatchObject({
      code: "ai_provider_not_configured",
      error: {
        message: expect.stringContaining(
          "vendor-ai's key isn't set for the base URL its row has now",
        ),
      },
    });
    expect(unbound.upstream).toBeUndefined();
  });
});
