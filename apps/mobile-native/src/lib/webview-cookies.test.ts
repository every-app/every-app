import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  getGatewayUrl: vi.fn(),
  set: vi.fn(),
  clearAll: vi.fn(),
}));

vi.mock("@react-native-cookies/cookies", () => ({
  default: {
    set: mocks.set,
    clearAll: mocks.clearAll,
  },
}));

vi.mock("@/src/lib/auth-client", () => ({
  authClient: {
    getCookie: mocks.getCookie,
  },
  getGatewayUrl: mocks.getGatewayUrl,
}));

import {
  clearWebViewCookies,
  syncSessionCookieToWebView,
} from "./webview-cookies";

describe("WebView cookie synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.set.mockResolvedValue(true);
    mocks.clearAll.mockResolvedValue(true);
  });

  it("parses and sets every cookie for gateway subdomains", async () => {
    mocks.getCookie.mockReturnValue(
      "__Secure-better-auth.session=abc=123; better-auth.session_data=xyz",
    );
    mocks.getGatewayUrl.mockReturnValue("https://example.com");

    await expect(syncSessionCookieToWebView()).resolves.toBe(true);

    expect(mocks.set).toHaveBeenNthCalledWith(
      1,
      "https://example.com",
      {
        name: "__Secure-better-auth.session",
        value: "abc=123",
        path: "/",
        httpOnly: true,
        secure: true,
        domain: "example.com",
      },
      true,
    );
    expect(mocks.set).toHaveBeenNthCalledWith(
      2,
      "https://example.com",
      {
        name: "better-auth.session_data",
        value: "xyz",
        path: "/",
        httpOnly: true,
        secure: true,
        domain: "example.com",
      },
      true,
    );
  });

  it("uses a non-secure host-only cookie for local HTTP gateways", async () => {
    mocks.getCookie.mockReturnValue("better-auth.session=local");
    mocks.getGatewayUrl.mockReturnValue("http://localhost:8787");

    await expect(syncSessionCookieToWebView()).resolves.toBe(true);

    expect(mocks.set).toHaveBeenCalledWith(
      "http://localhost:8787",
      {
        name: "better-auth.session",
        value: "local",
        path: "/",
        httpOnly: true,
        secure: false,
      },
      true,
    );
  });

  it("returns false without a cookie header", async () => {
    mocks.getCookie.mockReturnValue("");

    await expect(syncSessionCookieToWebView()).resolves.toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("only syncs Better Auth cookies", async () => {
    mocks.getCookie.mockReturnValue(
      "better-auth.session_token=abc; analytics_id=tracker; __Secure-other=x",
    );
    mocks.getGatewayUrl.mockReturnValue("https://example.com");

    await expect(syncSessionCookieToWebView()).resolves.toBe(true);

    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ name: "better-auth.session_token" }),
      true,
    );
  });

  it("clears both WebKit and non-WebKit stores", async () => {
    await clearWebViewCookies();

    expect(mocks.clearAll).toHaveBeenCalledWith(true);
    expect(mocks.clearAll).toHaveBeenCalledWith(false);
  });
});
