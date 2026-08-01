import { describe, expect, it } from "vitest";
import { normalizeTokenScope, normalizeTokenScopes } from "./app-token-scopes";

describe("app-token-scopes", () => {
  it("normalizes individual scopes", () => {
    expect(normalizeTokenScope(" provider:OpenAI ")).toBe("provider:openai");
    expect(normalizeTokenScope(" apps:Register ")).toBe("apps:register");
    expect(normalizeTokenScope("apps:deploy")).toBe("apps:deploy");
    expect(normalizeTokenScope("providers:*")).toBeNull();
    expect(normalizeTokenScope("provider:*")).toBeNull();
    expect(normalizeTokenScope("read:all")).toBeNull();
    expect(normalizeTokenScope("provider:open*ai")).toBeNull();
  });

  it("normalizes and deduplicates scope lists", () => {
    expect(
      normalizeTokenScopes([
        " provider:OpenAI ",
        "provider:openai",
        "provider:anthropic",
      ]),
    ).toEqual(["provider:openai", "provider:anthropic"]);
  });
});
