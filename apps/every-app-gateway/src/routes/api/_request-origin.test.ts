import { describe, expect, it } from "vitest";
import {
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
