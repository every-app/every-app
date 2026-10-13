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

describe("tapUsage", () => {
  it("passes the body through and reports usage at the end", async () => {
    const reported: unknown[] = [];
    const body = new Response(
      'data: {"x":1}\n\ndata: {"usage":{"input_tokens":2,"output_tokens":3}}\n\n',
    ).body!;

    const text = await new Response(
      tapUsage(body, (usage) => reported.push(usage)),
    ).text();

    expect(text).toContain('data: {"x":1}');
    expect(reported).toEqual([{ input: 2, output: 3, total: 5 }]);
  });
});
