import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { GUIDES } from "@/docs/providerGuides";
import { CLI } from "@/lib/output/command";
import { formatSteps, KEPT_SPACE, type Step } from "@/lib/output/steps";
import { plainText, providerConnectGuide, providerConnectSteps, providerKeyGuide, providerKeySteps } from "./providerDocs";

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

/** A step as it reads once drawn: its wrapped lines joined again, without color. */
const read = (lines: string[]) => stripVTControlCharacters(lines.join(" ")).replace(/\s+/g, " ");

/**
 * Every step of a page's guide is on the screen with the page's own words
 * in order, whatever the width, and each link's URL under it. The words
 * are the page's sentence with its Markdown marks alone taken out, the
 * CLI named as this run names it.
 */
function expectGuideShown(id: string, written: readonly string[], steps: Step[], redirectUri?: string) {
  expect(steps, id).toHaveLength(written.length);
  for (const [index, markdown] of written.entries()) {
    const words = markdown
      .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
      .replace(/`everyapp /g, `\`${CLI} `)
      .replace(/\*\*|`/g, "")
      .replace("redirect URI above", "redirect URI");
    const urls = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(([, href]) =>
      href!.startsWith("/") ? `https://everyapp.com${href}` : href!,
    );
    const step = steps[index]!;
    expect(stripVTControlCharacters(step.text).replaceAll(KEPT_SPACE, " "), `${id} step ${index + 1}`).toBe(words);
    expect(step.links?.map((link) => link.url), `${id} step ${index + 1}`).toEqual([
      ...urls,
      ...(redirectUri && /redirect URI/.test(markdown) ? [redirectUri] : []),
    ]);
    for (const width of [40, 80, 100]) {
      const drawn = formatSteps([step], width);
      const sentence = drawn.filter((line) => !/^ +(\S.* {2})?https?:\/\/\S+$/.test(stripVTControlCharacters(line)));
      expect(read(sentence), `${id} step ${index + 1} at ${width}`).toBe(`1. ${words}`);
      for (const line of sentence) expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual(width);
    }
  }
}

describe("providerConnectGuide", () => {
  it("shows every guide's own words in order, whatever the width, with each link's URL under its step", () => {
    for (const [id, company] of [
      ["slack", "slack"],
      ["github-oauth", "github"],
      ["linear-oauth", "linear"],
      ["google-workspace", "google"],
      ["microsoft-365", "microsoft"],
    ] as const) {
      expectGuideShown(id, GUIDES[company]!.connect!, providerConnectGuide(id, URI)!, URI);
    }
  });

  it("names this CLI in a step's command, bold and on one line", () => {
    const [, , , , retry] = providerConnectGuide("slack", URI)!;
    const drawn = formatSteps([retry!], 80);
    expect(drawn.map(stripVTControlCharacters)).toEqual([
      `1. A "request URL didn't respond" warning is fine before the app is deployed.`,
      "   Retry it under Event Subscriptions once the app is live and",
      `   ${CLI} access on has run.`,
    ]);
    expect(drawn.join("\n")).not.toContain(KEPT_SPACE);
    expect(providerConnectSteps("slack", URI)![4]).toContain(`once the app is live and ${CLI} access on has run.`);
  });

  it("draws one link as its URL alone, several with their names, and a blank line between steps of several lines", () => {
    const drawn = formatSteps(providerConnectGuide("google-workspace", URI)!.slice(0, 2), 100).map(stripVTControlCharacters);
    expect(drawn).toEqual([
      "1. Signed in to Google, create a Cloud project (for example EveryApp). With Google Workspace, put it",
      "   in your organization.",
      "   https://console.cloud.google.com/projectcreate",
      "",
      "2. Enable the APIs your apps use: for OpenSEO, the Search Console API, the Analytics Admin API and",
      "   the Analytics Data API; for OpenCRM, the Gmail API and the Google Calendar API.",
      "   Search Console API   https://console.cloud.google.com/apis/library/searchconsole.googleapis.com",
      "   Analytics Admin API  https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com",
      "   Analytics Data API   https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com",
    ]);
    // One line each: no blank lines between them.
    expect(formatSteps([{ text: "Create a key" }, { text: "Paste it below." }], 80)).toEqual([
      "1. Create a key",
      "2. Paste it below.",
    ]);
  });

  it("has none for a provider whose page has generic steps", () => {
    expect(providerConnectGuide("dropbox", URI)).toBeUndefined();
  });
});

describe("providerKeyGuide", () => {
  /** The pages with their own key steps: a company with one key, whose key is pasted. */
  const WITH_STEPS = Object.entries(GUIDES)
    .filter(([company, guide]) => guide.key && company !== "ai-gateway")
    .map(([company]) => company);

  it("shows every key guide's own words in order, whatever the width, with each link's URL under its step", () => {
    expect(WITH_STEPS).toContain("openrouter");
    expect(WITH_STEPS).toContain("dataforseo");
    for (const id of WITH_STEPS) expectGuideShown(id, GUIDES[id]!.key!, providerKeyGuide(id)!);
  });

  it("numbers them as plain text for a script, a link as its text and URL", () => {
    expect(providerKeySteps("groq")).toEqual([
      "1. Sign in to the Groq console (https://console.groq.com).",
      "2. Open API Keys (https://console.groq.com/keys) and select Create API Key.",
      "3. Copy the key. It's shown once.",
    ]);
  });

  it("has none for a page with generic steps, a company with several keys, a proxy, and an OAuth preset", () => {
    for (const id of ["exa", "turso", "turso-db", "ai-gateway", "github-oauth", "not-a-provider"]) {
      expect(providerKeyGuide(id), id).toBeUndefined();
      expect(providerKeySteps(id), id).toBeUndefined();
    }
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
