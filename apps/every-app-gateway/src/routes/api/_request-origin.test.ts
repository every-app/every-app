import { describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ env: {} as { GATEWAY_URL?: string } }));
vi.mock("cloudflare:workers", () => workers);

import {
  gatewayOrigin,
  JSON_HEADERS,
  SENSITIVE_JSON_HEADERS,
  jsonResponse,
} from "./_request-origin";

describe("jsonResponse", () => {
  it("uses standard json headers by default", () => {
    const response = jsonResponse({ ok: true });

    expect(response.headers.get("content-type")).toBe(
      JSON_HEADERS["Content-Type"],
    );
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("supports sensitive no-store headers when requested", () => {
    const response = jsonResponse({ ok: true }, 200, SENSITIVE_JSON_HEADERS);

    expect(response.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});

describe("gatewayOrigin", () => {
  const request = new Request("http://localhost:8787/api/setup/claim", {
    method: "POST",
  });

  it("is GATEWAY_URL's origin when it is set", () => {
    workers.env.GATEWAY_URL = "https://gateway.example.com/";
    expect(gatewayOrigin(request)).toBe("https://gateway.example.com");
  });

  it("falls back to the request's origin without one, or with a broken one", () => {
    delete workers.env.GATEWAY_URL;
    expect(gatewayOrigin(request)).toBe("http://localhost:8787");
    workers.env.GATEWAY_URL = "not a url";
    expect(gatewayOrigin(request)).toBe("http://localhost:8787");
  });
});
