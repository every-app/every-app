// @vitest-environment happy-dom
/**
 * The Edit dialog's sentence per capability, read as text: the grant it
 * states for each `scopesStatus`, and the fix it names when the gateway
 * refuses the app's tokens.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppCapabilitySummary } from "@/types/app";
import { CapabilitySentence } from "./CapabilitySentence";

const GOOGLE = "Google (Gmail, Calendar, Search Console and Analytics)";
const GMAIL = {
  name: "gmail.read",
  label: "Gmail (read-only)",
  access: "read",
} as const;
const CALENDAR = {
  name: "calendar.read",
  label: "Google Calendar (read-only)",
  access: "read",
} as const;

function google(summary: Partial<AppCapabilitySummary>): AppCapabilitySummary {
  return {
    id: "google-workspace",
    label: GOOGLE,
    access: "write",
    scopeSets: [],
    scopesStatus: "none",
    ...summary,
  };
}

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
    const slack: AppCapabilitySummary = {
      id: "slack",
      label: "Slack",
      access: "write",
      scopeSets: [],
      scopesStatus: "none",
    };
    expect(sentence(slack)).toBe("Slack, write access.");
    expect(sentence({ ...slack, why: "Posts digests" })).toBe(
      "Slack, write access, “Posts digests”.",
    );
    // A why written as a sentence doesn't end the line with two stops.
    expect(sentence({ ...slack, why: "Posts digests." })).toBe(
      "Slack, write access, “Posts digests”.",
    );
    expect(sentence({ ...slack, why: "Posts digests.. " })).toBe(
      "Slack, write access, “Posts digests”.",
    );
  });

  // Never "write access to Gmail (read-only)": the sets are the grant.
  it("leads a held grant with its sets and says what the gateway refuses", () => {
    expect(
      sentence(
        google({
          scopeSets: [GMAIL, CALENDAR],
          scopesStatus: "ok",
          why: "Reads the inbox and calendar you connect",
        }),
      ),
    ).toBe(
      `${GOOGLE}, tokens for Gmail (read-only), Google Calendar (read-only), “Reads the inbox and calendar you connect”: the gateway refuses tokens outside these sets; the app holds the tokens and calls the provider itself.`,
    );
    expect(sentence(google({ scopeSets: [GMAIL], scopesStatus: "ok" }))).toBe(
      `${GOOGLE}, tokens for Gmail (read-only): the gateway refuses tokens outside these sets; the app holds the tokens and calls the provider itself.`,
    );
  });

  it("names the fix for a scoped client with no sets at all", () => {
    expect(sentence(google({ scopesStatus: "undeclared" }))).toBe(
      `${GOOGLE} lists no usable scope sets, so the gateway refuses its tokens: name one or more under scopes in its capabilities entry and deploy the app again.`,
    );
  });

  it("says what voids a grant whose sets survive it, instead of listing them", () => {
    const text = sentence(
      google({ scopeSets: [GMAIL], scopesStatus: "undeclared" }),
    );
    expect(text).toBe(
      `${GOOGLE} lists a scope set twice, or an entry that isn't a set name, so the gateway refuses its tokens: list each set once under scopes in its capabilities entry and deploy the app again.`,
    );
    expect(text).not.toContain("Gmail (read-only)");
  });

  it("names the set this gateway doesn't offer and the two fixes", () => {
    expect(
      sentence(
        google({
          scopeSets: [
            GMAIL,
            {
              name: "drive.read",
              label: "drive.read (unknown to this gateway)",
            },
          ],
          scopesStatus: "unknown",
        }),
      ),
    ).toBe(
      `${GOOGLE} lists a scope set this gateway doesn't offer (drive.read), so the gateway refuses its tokens: update the gateway, or drop the set from scopes and deploy the app again.`,
    );
  });
});
