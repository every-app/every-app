// @vitest-environment happy-dom
/**
 * The Edit dialog's sentence per capability, read as text: an API key's
 * access, an OAuth provider's scopes, each with its why.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppCapabilitySummary } from "@/types/app";
import { CapabilitySentence } from "./CapabilitySentence";

/** The sentence as a reader sees it: the spans only set the type. */
function sentence(capability: AppCapabilitySummary): string {
  const host = document.createElement("p");
  host.innerHTML = renderToStaticMarkup(
    <CapabilitySentence capability={capability} />,
  );
  return host.textContent ?? "";
}

describe("CapabilitySentence", () => {
  it("states a plain capability's access, with its why", () => {
    const context: AppCapabilitySummary = {
      id: "context",
      label: "Context.dev",
      access: "read",
    };
    expect(sentence(context)).toBe("Context.dev, read access.");
    expect(sentence({ ...context, why: "Reads pages" })).toBe(
      "Context.dev, read access, “Reads pages”.",
    );
    // A why written as a sentence doesn't end the line with two stops.
    expect(sentence({ ...context, why: "Reads pages.. " })).toBe(
      "Context.dev, read access, “Reads pages”.",
    );
  });

  it("states an OAuth provider's scopes, or that it lists none", () => {
    expect(
      sentence({
        id: "google-workspace",
        label: "Google",
        scopes: ["gmail.modify", "gmail.send"],
        why: "Mirrors your Gmail",
      }),
    ).toBe("Google, scopes gmail.modify, gmail.send, “Mirrors your Gmail”.");
    expect(sentence({ id: "notion-oauth", label: "Notion", scopes: [] })).toBe(
      "Notion, no scopes.",
    );
  });
});
