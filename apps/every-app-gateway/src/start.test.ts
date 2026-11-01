import { describe, expect, it, vi } from "vitest";
import { startInstance } from "./start";

type ServerMiddleware = {
  options: {
    server: (ctx: {
      request: Request;
      handlerType: string;
      next: () => unknown;
    }) => Promise<unknown>;
  };
};

const GATEWAY = "https://gateway.example.com";

async function runCsrf(
  headers: Record<string, string>,
  handlerType = "serverFn",
) {
  const options = await startInstance.getOptions();
  const [csrf] = options.requestMiddleware as unknown as ServerMiddleware[];
  const next = vi.fn(() => "next");
  const result = await csrf.options.server({
    request: new Request(`${GATEWAY}/_serverFn/abc`, { headers }),
    handlerType,
    next,
  });
  return { result, next };
}

describe("start CSRF middleware", () => {
  it("registers exactly one request middleware", async () => {
    const options = await startInstance.getOptions();
    expect(options.requestMiddleware).toHaveLength(1);
  });

  it.each([
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["same-site (an app subdomain)", { "sec-fetch-site": "same-site" }],
    ["user-initiated (typed URL)", { "sec-fetch-site": "none" }],
    ["foreign Origin", { origin: "https://evil.example" }],
    ["foreign Referer", { referer: "https://evil.example/page" }],
    ["no provenance headers", {}],
  ])("rejects %s server-function calls", async (_label, headers) => {
    const { result, next } = await runCsrf(headers);
    expect(next).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it.each([
    ["Sec-Fetch-Site same-origin", { "sec-fetch-site": "same-origin" }],
    ["same Origin", { origin: GATEWAY }],
    ["same-origin Referer", { referer: `${GATEWAY}/admin` }],
  ])("allows %s server-function calls", async (_label, headers) => {
    const { result, next } = await runCsrf(headers);
    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe("next");
  });

  it("leaves page and API requests to their own handlers", async () => {
    const { next } = await runCsrf(
      { "sec-fetch-site": "cross-site" },
      "router",
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
