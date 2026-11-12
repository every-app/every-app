import { describe, expect, it } from "vitest";
import { whoChanged } from "./deploy";

const now = Date.parse("2026-11-12T06:00:00Z");
const at = (iso: string) => Date.parse(iso);

describe("whoChanged", () => {
  it("says who changed a secret, with what and when, as cf's deployments list it", () => {
    expect(
      whoChanged(
        {
          versionId: "7d1e5489",
          deployedAt: at("2026-11-11T18:03:05Z"),
          author: "ben@example.com",
          source: "cf_cli",
          triggeredBy: "secret",
          message: null,
        },
        now,
      ),
    ).toBe("ben@example.com changed a secret with cf, 12h ago");
  });

  it("names a deploy by its message, and the dashboard by name", () => {
    expect(
      whoChanged(
        {
          versionId: "v",
          deployedAt: at("2026-11-09T06:00:00Z"),
          author: "ben@example.com",
          source: "dash",
          triggeredBy: "deployment",
          message: null,
        },
        now,
      ),
    ).toBe("ben@example.com deployed it in the dashboard, 3d ago");
    expect(
      whoChanged(
        {
          versionId: "v",
          deployedAt: at("2026-11-12T05:58:00Z"),
          author: "carter@example.com",
          source: "cf_cli",
          triggeredBy: "deployment",
          message: "everyapp 0.4.0 gateway 0.4.0 (upgrade)",
        },
        now,
      ),
    ).toBe("carter@example.com deployed “everyapp 0.4.0 gateway 0.4.0 (upgrade)” with cf, 2m ago");
  });
});
