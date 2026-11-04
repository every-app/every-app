import { describe, expect, it } from "vitest";
import { plainText, providerConnectSteps } from "./providerDocs";

const URI = "https://apps.example.com/connect/slack/callback";

describe("providerConnectSteps", () => {
  it("prints the Slack page's steps as plain text, the redirect URI on its own line, no punctuation after a URL", () => {
    const steps = providerConnectSteps("slack", URI)!;
    expect(steps[0]).toMatch(/^1\. Open https:\/\/api\.slack\.com\/apps and select Create New App, then From scratch → Paste a manifest\./);
    expect(steps[1]).toBe(
      `2. The manifest's oauth_config.redirect_urls must contain the redirect URI. Or add it after, under OAuth & Permissions → Redirect URLs.\n   ${URI}`,
    );
    expect(steps.join("\n")).not.toMatch(/\*\*|`|\]\(/);
    expect(steps.join("\n")).toContain("xoxb-");
    expect(steps).toHaveLength(5);
  });

  it("never ends a URL with punctuation a terminal would link", () => {
    for (const id of ["slack", "github-oauth", "linear-oauth", "google-workspace", "microsoft-365"]) {
      const urls = (providerConnectSteps(id, URI) ?? []).join("\n").match(/https?:\/\/[^\s)]+/g) ?? [];
      expect(urls.length, id).toBeGreaterThan(0);
      for (const url of urls) expect(url, id).not.toMatch(/[,.;:!?]$/);
    }
  });

  it("has none for a provider whose page has generic steps", () => {
    expect(providerConnectSteps("dropbox", URI)).toBeUndefined();
    expect(providerConnectSteps("not-a-provider", URI)).toBeUndefined();
  });
});

describe("plainText", () => {
  it("keeps a link's text and URL, a bare URL alone, and drops bold and code ticks", () => {
    expect(plainText("Open [Keys](https://x.dev/keys), copy **Client ID** and `scope`.")).toBe(
      "Open Keys (https://x.dev/keys), copy Client ID and scope.",
    );
    expect(plainText("At [x.dev/keys](https://x.dev/keys) now")).toBe("At https://x.dev/keys now");
    expect(plainText("At [x.dev/keys](https://x.dev/keys), now")).toBe("At x.dev/keys (https://x.dev/keys), now");
    expect(plainText("[Guide](/docs/guide)")).toBe("Guide (https://everyapp.com/docs/guide)");
  });
});
