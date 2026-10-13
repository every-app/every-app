import { describe, expect, it } from "vitest";
import { domainCoversRedirect } from "./clientSite";

describe("domainCoversRedirect", () => {
  it("covers the domain itself, its subdomains and this computer", () => {
    expect(domainCoversRedirect("claude.ai", "claude.ai")).toBe(true);
    expect(domainCoversRedirect("chatgpt.com", "auth.chatgpt.com")).toBe(true);
    for (const loopback of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]"]) {
      expect(domainCoversRedirect("claude.ai", loopback), loopback).toBe(true);
    }
  });

  it("covers no other site, however its name ends or starts", () => {
    for (const host of [
      "evil.example",
      "notclaude.ai",
      "claude.ai.evil.example",
      "ai",
      "127.0.0.1.evil.example",
      "128.0.0.1",
    ]) {
      expect(domainCoversRedirect("claude.ai", host), host).toBe(false);
    }
    // A parent of the document's host is another site too.
    expect(
      domainCoversRedirect(
        "gist.githubusercontent.com",
        "githubusercontent.com",
      ),
    ).toBe(false);
  });
});
