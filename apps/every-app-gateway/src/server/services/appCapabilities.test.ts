import { describe, expect, it } from "vitest";
import { appCapabilities } from "./appCapabilities";

/** A stored manifest snapshot listing the given capabilities. */
function manifest(capabilities: unknown): string {
  return JSON.stringify({ id: "crm", capabilities });
}

const GMAIL = {
  name: "gmail.read",
  label: "Gmail (read-only)",
  access: "read",
};
const CALENDAR = {
  name: "calendar.read",
  label: "Google Calendar (read-only)",
  access: "read",
};

describe("appCapabilities", () => {
  it("reads labels, access, why and set labels against the registry", () => {
    expect(
      appCapabilities(
        manifest({
          "google-workspace": {
            access: "write",
            scopes: ["gmail.read", "calendar.read"],
            why: "Reads the inbox and calendar you connect",
          },
          // A capability without scope sets, with a why.
          context: { access: "read", why: "Reads the pages you track" },
          dataforseo: { access: "read" },
        }),
      ),
    ).toEqual([
      {
        id: "google-workspace",
        label: "Google (Gmail, Calendar, Search Console and Analytics)",
        access: "write",
        why: "Reads the inbox and calendar you connect",
        scopeSets: [GMAIL, CALENDAR],
        scopesStatus: "ok",
      },
      {
        id: "context",
        label: "Context.dev",
        access: "read",
        why: "Reads the pages you track",
        scopeSets: [],
        scopesStatus: "none",
      },
      {
        id: "dataforseo",
        label: "DataForSEO",
        access: "read",
        scopeSets: [],
        scopesStatus: "none",
      },
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

  it("keeps a set this gateway doesn't offer, marked, and reads the grant as unknown", () => {
    expect(
      appCapabilities(
        manifest({
          "google-workspace": {
            access: "write",
            scopes: ["gmail.read", "drive.read"],
          },
        }),
      ),
    ).toEqual([
      {
        id: "google-workspace",
        label: "Google (Gmail, Calendar, Search Console and Analytics)",
        access: "write",
        scopeSets: [
          GMAIL,
          { name: "drive.read", label: "drive.read (unknown to this gateway)" },
        ],
        scopesStatus: "unknown",
      },
    ]);
  });

  // The token endpoint reads each of these as no grant at all.
  it.each([
    ["no scopes", { access: "write" }, []],
    ["an empty list", { access: "write", scopes: [] }, []],
    ["a non-list", { access: "write", scopes: "gmail.read" }, []],
    [
      "a name listed twice",
      { access: "write", scopes: ["gmail.read", "gmail.read"] },
      [GMAIL],
    ],
    // The lenient manifest schema reads a list with a non-string entry as no
    // `scopes` at all, so no name survives to be labelled.
    ["a non-string entry", { access: "write", scopes: ["gmail.read", 7] }, []],
  ])(
    "reads a scoped client with %s as undeclared",
    (_case, entry, scopeSets) => {
      const [google] = appCapabilities(manifest({ "google-workspace": entry }));
      expect(google).toMatchObject({ scopeSets, scopesStatus: "undeclared" });
    },
  );

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
