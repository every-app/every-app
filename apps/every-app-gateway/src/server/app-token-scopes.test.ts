import { describe, expect, it } from "vitest";
import {
  hasProviderScope,
  normalizeProviderName,
  normalizeTokenScope,
  normalizeTokenScopes,
} from "./app-token-scopes";

describe("app-token-scopes", () => {
  it("normalizes provider names", () => {
    expect(normalizeProviderName(" OpenAI ")).toBe("openai");
  });

  it("normalizes individual scopes", () => {
    expect(normalizeTokenScope(" provider:OpenAI ")).toBe("provider:openai");
    expect(normalizeTokenScope("providers:*")).toBe("provider:*");
    expect(normalizeTokenScope("provider:*")).toBe("provider:*");
    expect(normalizeTokenScope("read:all")).toBeNull();
    expect(normalizeTokenScope("provider:open*ai")).toBeNull();
  });

  it("normalizes and deduplicates scope lists", () => {
    expect(
      normalizeTokenScopes([
        " provider:OpenAI ",
        "provider:openai",
        "providers:*",
      ]),
    ).toEqual(["provider:openai", "provider:*"]);
  });

  it("matches provider scopes with normalization and wildcard support", () => {
    expect(hasProviderScope(["provider:openai"], " openai ")).toBe(true);
    expect(hasProviderScope(["providers:*"], "anthropic")).toBe(true);
    expect(hasProviderScope(["provider:anthropic"], "openai")).toBe(false);
  });
});
