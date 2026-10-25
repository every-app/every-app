import { describe, expect, it } from "vitest";
import { extractUsage, tapUsage } from "./ai-usage";

describe("extractUsage", () => {
  it("reads Responses API and chat completion usage", () => {
    expect(
      extractUsage(
        '{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":2},"output_tokens":4,"total_tokens":14}}',
      ),
    ).toEqual({ input: 10, output: 4, total: 14 });
    expect(
      extractUsage('{"usage":{"prompt_tokens":3,"completion_tokens":7}}'),
    ).toEqual({ input: 3, output: 7, total: 10 });
  });

  it("takes the last usage in a stream and returns null without one", () => {
    const sse = [
      'data: {"type":"response.created","response":{"usage":null}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":1,"total_tokens":10}}}',
    ].join("\n\n");
    expect(extractUsage(sse)).toEqual({ input: 9, output: 1, total: 10 });
    expect(extractUsage('data: {"choices":[]}')).toBeNull();
  });
});

describe("extractUsage with a cost path", () => {
  it("reads the call's price under the path, after the last mention of its parent, and never a cost in the text", () => {
    const body =
      '{"choices":[{"message":{"content":"the cost is 12 and \\"cost\\": 99"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.00042}}';
    expect(extractUsage(body, "usage.cost")).toEqual({
      input: 10,
      output: 5,
      total: 15,
      cost: 0.00042,
    });
    // Without the path nothing is read; without the field nothing is reported.
    expect(extractUsage(body)).toEqual({ input: 10, output: 5, total: 15 });
    expect(
      extractUsage(
        '{"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        "usage.cost",
      ),
    ).toEqual({ input: 1, output: 1, total: 2 });
    // A stream: the last usage chunk's figure wins.
    const stream = [
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.001}}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":9,"cost":0.004}}',
      "data: [DONE]",
    ].join("\n\n");
    expect(extractUsage(stream, "usage.cost")).toEqual({
      input: 3,
      output: 9,
      total: 12,
      cost: 0.004,
    });
  });
});

describe("tapUsage", () => {
  it("passes the body through and reports usage at the end", async () => {
    const reported: unknown[] = [];
    const body = new Response(
      'data: {"x":1}\n\ndata: {"usage":{"input_tokens":2,"output_tokens":3}}\n\n',
    ).body!;

    const text = await new Response(
      tapUsage(body, (usage, ended) => reported.push([usage, ended])),
    ).text();

    expect(text).toContain('data: {"x":1}');
    expect(reported).toEqual([[{ input: 2, output: 3, total: 5 }, "done"]]);
  });

  /** A stream that sends `chunks` and then never closes, like an abandoned SSE. */
  function openEnded(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
    });
  }

  // In-isolate only: workerd runs no cancel() for a browser or app Worker
  // that disconnects on the other side of the boundary (response-tap.ts).
  it("reports once, with what the tail held, when a reader in this isolate gives up before the end", async () => {
    const reported: unknown[] = [];
    const tapped = tapUsage(
      openEnded('data: {"usage":{"input_tokens":7,"output_tokens":1}}\n\n'),
      (usage, ended) => reported.push([usage, ended]),
    );

    const reader = tapped.getReader();
    await reader.read();
    await reader.cancel("the person closed the tab");
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(reported).toEqual([
      [{ input: 7, output: 1, total: 8 }, "cancelled"],
    ]);
  });

  it("reports once, with null, when the provider fails mid-body", async () => {
    const reported: unknown[] = [];
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
        controller.error(new Error("connection reset"));
      },
    });

    await expect(
      new Response(
        tapUsage(failing, (usage, ended) => reported.push([usage, ended])),
      ).text(),
    ).rejects.toThrow("connection reset");

    expect(reported).toEqual([[null, "failed"]]);
  });
});
