import { describe, expect, it } from "vitest";
import { assertSettableSecret } from "./secretsFile";

describe("gateway settings `secret set --for gateway` changes", () => {
  it.each([
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DATAFORSEO_API_KEY",
    "CONTEXT_API_KEY",
  ])("include the provider key %s", (name) => {
    expect(() => assertSettableSecret(name)).not.toThrow();
  });

  it.each(["JWT_PRIVATE_KEY", "BETTER_AUTH_SECRET", "GATEWAY_DEPLOYMENT_MODE"])(
    "never include %s, which the install owns",
    (name) => {
      expect(() => assertSettableSecret(name)).toThrow(
        expect.objectContaining({ code: "SECRET_NOT_SETTABLE" }),
      );
    },
  );
});
