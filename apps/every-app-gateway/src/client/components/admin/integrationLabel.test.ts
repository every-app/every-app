import { describe, expect, it } from "vitest";
import type { AppCapabilitySummary } from "@/types/app";
import { integrationLabel } from "./integrationLabel";

const IDENTITY = {
  name: "identity",
  label: "Google account (who you are)",
  access: "read",
} as const;
const GMAIL = {
  name: "gmail.read",
  label: "Gmail (read-only)",
  access: "read",
} as const;

function google(summary: Partial<AppCapabilitySummary>): AppCapabilitySummary {
  return {
    id: "google-workspace",
    label: "Google (Gmail, Calendar, Search Console and Analytics)",
    access: "write",
    scopeSets: [],
    scopesStatus: "none",
    ...summary,
  };
}

describe("integrationLabel", () => {
  it("keeps the registry label of a client without scope sets", () => {
    expect(
      integrationLabel({
        id: "slack",
        label: "Slack",
        access: "write",
        scopeSets: [],
        scopesStatus: "none",
      }),
    ).toBe("Slack");
  });

  it("carries the sets on the provider's short name, each as a noun with its access bare", () => {
    expect(
      integrationLabel(
        google({ scopeSets: [IDENTITY, GMAIL], scopesStatus: "ok" }),
      ),
    ).toBe("Google (Google account, Gmail read-only)");
  });

  it("keeps the gateway's mark on a set it doesn't offer", () => {
    expect(
      integrationLabel(
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
    ).toBe("Google (Gmail read-only, drive.read (unknown to this gateway))");
  });

  it("marks a void grant instead of listing the sets that survived it", () => {
    expect(integrationLabel(google({ scopesStatus: "undeclared" }))).toBe(
      "Google (no usable scope sets)",
    );
    expect(
      integrationLabel(
        google({ scopeSets: [GMAIL], scopesStatus: "undeclared" }),
      ),
    ).toBe("Google (no usable scope sets)");
  });
});
