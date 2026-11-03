import { describe, expect, it } from "vitest";
import { appCapabilities } from "./appCapabilities";

/** A stored manifest snapshot listing the given capabilities. */
function manifest(capabilities: unknown): string {
  return JSON.stringify({ id: "crm", capabilities });
}

describe("appCapabilities", () => {
  it("reads labels, why, an OAuth provider's scopes and another capability's access", () => {
    const [google, ...rest] = appCapabilities(
      manifest({
        "google-workspace": {
          scopes: ["gmail.modify", "gmail.send", "gmail.send"],
          why: "Mirrors your Gmail",
        },
        context: { access: "read", why: "Reads the pages you track" },
        dataforseo: { access: "read" },
      }),
    );
    expect(google).toMatchObject({
      id: "google-workspace",
      why: "Mirrors your Gmail",
      scopes: ["gmail.modify", "gmail.send"],
    });
    expect(google).not.toHaveProperty("access");
    expect(rest).toEqual([
      {
        id: "context",
        label: "Context.dev",
        access: "read",
        why: "Reads the pages you track",
      },
      { id: "dataforseo", label: "DataForSEO", access: "read" },
    ]);
  });

  it("drops a capability this gateway's registry doesn't know", () => {
    expect(
      appCapabilities(
        manifest({
          "not-a-provider": { access: "read", why: "From a newer registry" },
          dataforseo: { access: "read" },
        }),
      ).map((capability) => capability.id),
    ).toEqual(["dataforseo"]);
  });

  it("lists nothing for a manifest without capabilities", () => {
    expect(appCapabilities(JSON.stringify({ id: "crm" }))).toEqual([]);
  });

  it.each([
    ["null", null],
    ["not JSON", "{not json"],
    ["not a manifest", JSON.stringify({ capabilities: { dataforseo: 1 } })],
  ])("lists nothing for a manifest that is %s", (_case, stored) => {
    expect(appCapabilities(stored)).toEqual([]);
  });
});
