import { describe, expect, it } from "vitest";
import {
  hasDisallowedNativeOrigin,
  normalizeExpoOrigin,
} from "./expo-origin-normalizer";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://gateway.example.com/api/auth/sign-in", {
    method: "POST",
    headers,
  });
}

describe("normalizeExpoOrigin", () => {
  it("keeps request unchanged when origin is already set", () => {
    const request = makeRequest({
      origin: "https://app.example.com",
      "expo-origin": "everyapp://",
    });

    const normalized = normalizeExpoOrigin(request);

    expect(normalized).toBe(request);
    expect(normalized.headers.get("origin")).toBe("https://app.example.com");
  });

  it("promotes the everyapp:// expo-origin to origin", () => {
    const request = makeRequest({ "expo-origin": "everyapp://" });

    const normalized = normalizeExpoOrigin(request);

    expect(normalized.headers.get("origin")).toBe("everyapp://");
  });

  it("is case-insensitive for the scheme but preserves the header verbatim", () => {
    const request = makeRequest({ "expo-origin": "EveryApp://" });

    const normalized = normalizeExpoOrigin(request);

    expect(normalized.headers.get("origin")).toBe("EveryApp://");
  });

  it("ignores exp:// dev-client origins", () => {
    const request = makeRequest({ "expo-origin": "exp://192.168.1.5:8081" });

    const normalized = normalizeExpoOrigin(request);

    expect(normalized).toBe(request);
    expect(normalized.headers.get("origin")).toBeNull();
  });

  it("ignores non-url, credentialed, and decorated origins", () => {
    for (const value of [
      "not-a-url",
      "everyapp://user:pass@host",
      "everyapp://?q=1",
      "everyapp://#frag",
      "https://evil.example.com",
    ]) {
      const normalized = normalizeExpoOrigin(
        makeRequest({ "expo-origin": value }),
      );
      expect(normalized.headers.get("origin")).toBeNull();
    }
  });

  it("ignores requests without an expo-origin header", () => {
    const request = makeRequest({});

    expect(normalizeExpoOrigin(request)).toBe(request);
  });
});

describe("hasDisallowedNativeOrigin", () => {
  it("allows web origins, exact everyapp://, and absent headers", () => {
    expect(hasDisallowedNativeOrigin(makeRequest({}))).toBe(false);
    expect(
      hasDisallowedNativeOrigin(
        makeRequest({ origin: "https://gateway.example.com" }),
      ),
    ).toBe(false);
    expect(
      hasDisallowedNativeOrigin(makeRequest({ origin: "everyapp://" })),
    ).toBe(false);
    expect(
      hasDisallowedNativeOrigin(
        makeRequest({
          "expo-origin": "everyapp://",
          referer: "https://gateway.example.com/sign-in",
        }),
      ),
    ).toBe(false);
  });

  it("rejects prefix-matching abuse of the everyapp scheme", () => {
    // Better Auth matches non-HTTP trusted origins by prefix; these would
    // all pass its check against a trusted "everyapp://".
    for (const value of [
      "everyapp://evil",
      "everyapp:///path",
      "everyapp://?q=1",
    ]) {
      expect(hasDisallowedNativeOrigin(makeRequest({ origin: value }))).toBe(
        true,
      );
      expect(hasDisallowedNativeOrigin(makeRequest({ referer: value }))).toBe(
        true,
      );
    }
  });

  it("rejects exp:// and other custom schemes outright", () => {
    expect(
      hasDisallowedNativeOrigin(
        makeRequest({ origin: "exp://192.168.1.5:8081" }),
      ),
    ).toBe(true);
    expect(
      hasDisallowedNativeOrigin(makeRequest({ "expo-origin": "otherapp://" })),
    ).toBe(true);
  });
});
