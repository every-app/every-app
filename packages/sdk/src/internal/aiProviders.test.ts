import { describe, expect, it } from "vitest";
import {
  joinProviderUrl,
  normalizeWorkersAiResponse,
  workersAiBasePath,
} from "./aiProviders";

/** A response whose body arrives in the given pieces. */
function streamed(
  pieces: readonly (string | Uint8Array)[],
  contentType = "text/event-stream",
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            typeof piece === "string" ? encoder.encode(piece) : piece,
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": contentType, "content-length": "999" } },
  );
}

const CHAT = "/v1/chat/completions";

describe("joinProviderUrl", () => {
  it("joins the path onto the base's own path and sets the query", () => {
    expect(
      joinProviderUrl(
        `https://api.cloudflare.com${workersAiBasePath("acc 1")}`,
        "/v1/chat/completions",
        "?stream=true",
      )?.toString(),
    ).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc%201/ai/v1/chat/completions?stream=true",
    );
    expect(
      joinProviderUrl("https://api.openai.com", "/v1/responses")?.toString(),
    ).toBe("https://api.openai.com/v1/responses");
    expect(
      joinProviderUrl("https://example.com/base/", "/v1/x")?.toString(),
    ).toBe("https://example.com/base/v1/x");
  });

  it("refuses a path that would leave the base's path", () => {
    expect(
      joinProviderUrl("https://api.cloudflare.com/client/v4/a/ai", "/../../x"),
    ).toBeNull();
  });
});

describe("normalizeWorkersAiResponse", () => {
  it("turns numeric delta text into strings and keeps every other line byte for byte", async () => {
    const events = [
      'data: {"choices":[{"index":0,"delta":{"content":" of"}}],"usage":{"neurons":0.07727272808551788}}',
      'data: {"choices":[{"index":0,"delta":{"content":18}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":-3.5,"reasoning_content":7}}]}',
      ": a comment",
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think 18"}}]}',
      "data: [DONE]",
    ];
    const response = normalizeWorkersAiResponse(
      CHAT,
      streamed([events.join("\n\n") + "\n\n"]),
    );

    const out = (await response.text()).split("\n\n");
    expect(out[0]).toBe(events[0]);
    expect(JSON.parse(out[1]!.slice(6))).toEqual({
      choices: [{ index: 0, delta: { content: "18" } }],
    });
    expect(JSON.parse(out[2]!.slice(6)).choices[0].delta).toEqual({
      content: "-3.5",
      reasoning_content: "7",
    });
    expect(out.slice(3, 6)).toEqual(events.slice(3));
    // The length changed, so the upstream's no longer holds.
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("handles events split anywhere, a multi-byte character included", async () => {
    const text =
      'data: {"choices":[{"delta":{"content":"18°C"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":18}}]}\r\n\r\ndata: [DONE]';
    const bytes = new TextEncoder().encode(text);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5)
      pieces.push(bytes.slice(i, i + 5));

    const out = await normalizeWorkersAiResponse(CHAT, streamed(pieces)).text();

    expect(out).toBe(
      'data: {"choices":[{"delta":{"content":"18°C"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"18"}}]}\r\n\r\ndata: [DONE]',
    );
  });

  it("fixes a whole JSON body's message text and keeps any other body as sent", async () => {
    const fixed = await normalizeWorkersAiResponse(
      CHAT,
      streamed(
        [
          '{"choices":[{"index":0,"message":{"role":"assistant","content":42}}]}',
        ],
        "application/json",
      ),
    ).json();
    expect(fixed).toEqual({
      choices: [{ index: 0, message: { role: "assistant", content: "42" } }],
    });

    const untouched = '{ "choices": [{ "message": { "content": "42" } }] }';
    await expect(
      normalizeWorkersAiResponse(
        CHAT,
        streamed([untouched], "application/json; charset=utf-8"),
      ).text(),
    ).resolves.toBe(untouched);
  });

  it("leaves other routes and other content types alone", () => {
    const embeddings = streamed(['{"data":[]}'], "application/json");
    expect(normalizeWorkersAiResponse("/v1/embeddings", embeddings)).toBe(
      embeddings,
    );
    const html = streamed(["<html>"], "text/html");
    expect(normalizeWorkersAiResponse(CHAT, html)).toBe(html);
  });
});
