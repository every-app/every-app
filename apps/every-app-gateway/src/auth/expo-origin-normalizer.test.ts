import { describe, expect, it } from "vitest";
import {
  getExpoDevTrustedOrigins,
  isExpoDevModeEnabled,
  isDevelopmentGatewayUrl,
  normalizeExpoOrigin,
} from "./expo-origin-normalizer";

describe("isDevelopmentGatewayUrl", () => {
  it("detects local gateway urls", () => {
    expect(isDevelopmentGatewayUrl("http://localhost:3000")).toBe(true);
    expect(isDevelopmentGatewayUrl("http://[::1]:3000")).toBe(true);
    expect(isDevelopmentGatewayUrl("http://127.0.0.1:3000")).toBe(true);
  });

  it("rejects non-url values and non-local hosts", () => {
    expect(isDevelopmentGatewayUrl("gateway-ngrok.example.com")).toBe(false);
    expect(isDevelopmentGatewayUrl("https://x.trycloudflare.com")).toBe(false);
    expect(isDevelopmentGatewayUrl("https://foo.ngrok-free.app")).toBe(false);
    expect(isDevelopmentGatewayUrl("not-a-url")).toBe(false);
  });

  it("returns false for production host", () => {
    expect(isDevelopmentGatewayUrl("https://gateway.example.com")).toBe(false);
  });
});

describe("isExpoDevModeEnabled", () => {
  it("requires both vite dev mode and a dev gateway url", () => {
    expect(
      isExpoDevModeEnabled({
        gatewayUrl: "http://localhost:3000",
        viteDev: true,
      }),
    ).toBe(true);

    expect(
      isExpoDevModeEnabled({
        gatewayUrl: "http://localhost:3000",
        viteDev: false,
      }),
    ).toBe(false);

    expect(
      isExpoDevModeEnabled({
        gatewayUrl: "https://gateway.example.com",
        viteDev: true,
      }),
    ).toBe(false);
  });
});

describe("getExpoDevTrustedOrigins", () => {
  it("returns no exp origins when dev mode is disabled", () => {
    expect(getExpoDevTrustedOrigins(false)).toEqual([]);
  });

  it("returns a single broad exp origin pattern in dev mode", () => {
    expect(getExpoDevTrustedOrigins(true)).toEqual(["exp://**"]);
  });
});

describe("normalizeExpoOrigin", () => {
  it("keeps request unchanged when origin is already set", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "expo-origin": "everyapp://",
        },
      },
    );

    const normalized = normalizeExpoOrigin(request, { isDevMode: true });

    expect(normalized).toBe(request);
    expect(normalized.headers.get("origin")).toBe("https://app.example.com");
  });

  it("maps expo-origin to origin for everyapp scheme", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "everyapp://",
        },
      },
    );

    const normalized = normalizeExpoOrigin(request, { isDevMode: false });

    expect(normalized).not.toBe(request);
    expect(normalized.headers.get("origin")).toBe("everyapp://");
  });

  it("rejects everyapp origins with hostnames", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "everyapp://attacker",
        },
      },
    );

    const normalized = normalizeExpoOrigin(request, { isDevMode: true });

    expect(normalized).toBe(request);
    expect(normalized.headers.get("origin")).toBeNull();
  });

  it("allows exp:// origins only in development", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "exp://10.0.0.123:8081",
        },
      },
    );

    const devNormalized = normalizeExpoOrigin(request, { isDevMode: true });
    const prodNormalized = normalizeExpoOrigin(request, { isDevMode: false });

    expect(devNormalized.headers.get("origin")).toBe("exp://10.0.0.123:8081");
    expect(prodNormalized).toBe(request);
    expect(prodNormalized.headers.get("origin")).toBeNull();
  });

  it("allows exp:// IPv6 loopback origins in development", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "exp://[::1]:8081",
        },
      },
    );

    const devNormalized = normalizeExpoOrigin(request, { isDevMode: true });
    const prodNormalized = normalizeExpoOrigin(request, { isDevMode: false });

    expect(devNormalized.headers.get("origin")).toBe("exp://[::1]:8081");
    expect(prodNormalized).toBe(request);
    expect(prodNormalized.headers.get("origin")).toBeNull();
  });

  it("allows non-local exp:// origins in development", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "exp://evil.example.com:8081",
        },
      },
    );

    const normalized = normalizeExpoOrigin(request, { isDevMode: true });

    expect(normalized).not.toBe(request);
    expect(normalized.headers.get("origin")).toBe(
      "exp://evil.example.com:8081",
    );
  });

  it("ignores unknown expo-origin schemes", () => {
    const request = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "evil://app",
        },
      },
    );

    const normalized = normalizeExpoOrigin(request, { isDevMode: true });

    expect(normalized).toBe(request);
    expect(normalized.headers.get("origin")).toBeNull();
  });

  it("ignores malformed or credentialed expo-origin values", () => {
    const withCreds = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "everyapp://user:pass@app",
        },
      },
    );

    const malformed = new Request(
      "https://gateway.example.com/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "expo-origin": "everyapp://%ZZ",
        },
      },
    );

    const credsResult = normalizeExpoOrigin(withCreds, { isDevMode: true });
    const malformedResult = normalizeExpoOrigin(malformed, { isDevMode: true });

    expect(credsResult.headers.get("origin")).toBeNull();
    expect(malformedResult.headers.get("origin")).toBeNull();
  });
});
