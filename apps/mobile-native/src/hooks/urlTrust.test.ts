import { describe, expect, it } from "vitest";
import { isAllowedWebViewUrl, shouldAllowWebViewNavigation } from "./urlTrust";

const appOrigin = "https://todo.example.com";

describe("WebView origin allowlist", () => {
  it("allows the app origin", () => {
    expect(
      isAllowedWebViewUrl(
        "https://todo.example.com/tasks?filter=open",
        appOrigin,
      ),
    ).toBe(true);
  });

  it("blocks a foreign top-frame origin", () => {
    expect(
      shouldAllowWebViewNavigation(
        { url: "https://evil.example.net/phishing", isTopFrame: true },
        appOrigin,
      ),
    ).toBe(false);
  });

  it("allows about:blank", () => {
    expect(isAllowedWebViewUrl("about:blank", appOrigin)).toBe(true);
  });

  it("allows non-top-frame requests to pass through", () => {
    expect(
      shouldAllowWebViewNavigation(
        { url: "https://cdn.example.net/app.js", isTopFrame: false },
        appOrigin,
      ),
    ).toBe(true);
  });
});
