import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  createGatewayFetch: vi.fn(),
  requireEveryAppUser: vi.fn(),
  createOpenAI: vi.fn(),
  streamText: vi.fn(),
  verifyOwnership: vi.fn(),
  touchChat: vi.fn(),
  saveUserMessage: vi.fn(),
  getMessagesForChat: vi.fn(),
  toOpenAIFormat: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

vi.mock("@every-app/sdk/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@every-app/sdk/server")>();
  mocks.createGatewayFetch.mockImplementation(actual.createGatewayFetch);
  return {
    ...actual,
    createGatewayFetch: mocks.createGatewayFetch,
    requireEveryAppUser: mocks.requireEveryAppUser,
  };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock("ai", () => ({ streamText: mocks.streamText }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@/server/services/ChatService", () => ({
  ChatService: {
    verifyOwnership: mocks.verifyOwnership,
    touch: mocks.touchChat,
  },
}));
vi.mock("@/server/services/MessageService", () => ({
  MessageService: {
    saveUserMessage: mocks.saveUserMessage,
    getMessagesForChat: mocks.getMessagesForChat,
    toOpenAIFormat: mocks.toOpenAIFormat,
  },
}));
vi.mock("@/server/tools/recipeTools", () => ({ recipeTools: {} }));

import { Route } from "@/routes/api/chat";

const handleChatPost = (
  Route as unknown as {
    server: {
      handlers: {
        POST(input: { request: Request }): Promise<Response>;
      };
    };
  }
).server.handlers.POST;

describe("chat gateway streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.env)) delete mocks.env[key];

    mocks.requireEveryAppUser.mockResolvedValue({
      id: "user-1",
      email: "chef@example.com",
    });
    mocks.verifyOwnership.mockResolvedValue(true);
    mocks.touchChat.mockResolvedValue(undefined);
    mocks.saveUserMessage.mockResolvedValue(undefined);
    mocks.getMessagesForChat.mockResolvedValue([]);
    mocks.toOpenAIFormat.mockResolvedValue([]);
  });

  it("routes OpenAI through the binding without buffering its response", async () => {
    const encoder = new TextEncoder();
    let releaseSecondChunk = () => {};

    const bindingFetch = vi.fn(async (_request: Request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first"));
          releaseSecondChunk = () => {
            controller.enqueue(encoder.encode("second"));
            controller.close();
          };
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    mocks.env.EVERY_APP_GATEWAY = { fetch: bindingFetch };

    let providerOptions: {
      apiKey: string;
      baseURL: string;
      fetch: typeof fetch;
    } | null = null;
    mocks.createOpenAI.mockImplementation((options) => {
      providerOptions = options;
      return (modelId: string) => ({ modelId, gatewayFetch: options.fetch });
    });
    mocks.streamText.mockImplementation((options) => {
      const model = options.model as {
        modelId: string;
        gatewayFetch: typeof fetch;
      };
      const gatewayResponse = model.gatewayFetch(
        "https://every-app-gateway.invalid/api/ai/openai/v1/responses",
        {
          method: "POST",
          headers: { authorization: "Bearer gateway-managed" },
          body: JSON.stringify({ stream: true }),
        },
      );

      return {
        toUIMessageStreamResponse() {
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              const response = await gatewayResponse;
              const reader = response.body!.getReader();
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                controller.enqueue(chunk.value);
              }
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      };
    });

    const request = new Request("https://chef.example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-everyapp-identity": "signed-user-identity",
      },
      body: JSON.stringify({
        chatId: "88d10c96-c0de-4f6a-8b6c-60ca965aef40",
        message: {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "Dinner ideas?" }],
        },
      }),
    });

    const response = await handleChatPost({ request });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(mocks.createGatewayFetch).toHaveBeenCalledWith({
      env: mocks.env,
      request,
    });
    expect(providerOptions).toMatchObject({
      apiKey: "gateway-managed",
      baseURL: "https://every-app-gateway.invalid/api/ai/openai/v1",
    });
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: "gpt-5.2" }),
      }),
    );

    expect(bindingFetch).toHaveBeenCalledOnce();
    const bindingRequest = bindingFetch.mock.calls[0]![0] as Request;
    expect(bindingRequest.url).toBe(
      "http://every-app-gateway.internal/api/ai/openai/v1/responses",
    );
    expect(bindingRequest.headers.has("authorization")).toBe(false);
    expect(bindingRequest.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );

    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: encoder.encode("first"),
    });

    let secondReadSettled = false;
    const secondRead = reader.read().then((chunk) => {
      secondReadSettled = true;
      return chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondReadSettled).toBe(false);

    releaseSecondChunk();
    await expect(secondRead).resolves.toEqual({
      done: false,
      value: encoder.encode("second"),
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
