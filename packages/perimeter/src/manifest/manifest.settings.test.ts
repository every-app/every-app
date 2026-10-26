import { describe, expect, it } from "vitest";
import {
  manifestTierProblems,
  validateManifest,
  validateManifestStrict,
} from "./manifest";

const strict =
  (settings: unknown, extra: Record<string, unknown> = {}) =>
  () =>
    validateManifestStrict({ id: "mc", settings, ...extra });

describe("settings manifest field", () => {
  it("takes plain settings with a why, a type, values", () => {
    const manifest = validateManifestStrict({
      id: "mc",
      settings: [
        { name: "POSTHOG_HOST", why: "Where events go.", type: "url" },
        {
          name: "POSTHOG_PROJECT_ID",
          why: "Which project.",
          type: "number",
          docs: "https://posthog.com/docs",
        },
        {
          name: "REGION",
          why: "Where data lives.",
          values: ["us", "eu"],
          optional: true,
        },
      ],
    });
    expect(manifest.settings).toHaveLength(3);
  });

  it.each([
    [[{ name: "A" }], "settings.0.why"],
    [[{ name: "A", why: "x", anyOf: "g" }], 'Unrecognized key: "anyOf"'],
    [[{ name: "A", why: "x", type: "date" }], "settings.0.type"],
    [
      [{ name: "A", why: "x", type: "url", values: ["a", "b"] }],
      'values lists what a text setting may be; drop type "url" or values',
    ],
    [[{ name: "A", why: "x", values: ["a"] }], "settings.0.values"],
    [[{ name: "A", why: "x", values: ["a", "a"] }], "each value once"],
    [[{ name: "A", why: "x", default: "a" }], 'Unrecognized key: "default"'],
    [
      [
        { name: "A", why: "x" },
        { name: "A", why: "y" },
      ],
      "duplicate setting A",
    ],
    [
      [{ name: "GATEWAY_URL", why: "x" }],
      "GATEWAY_URL is set by everyapp itself",
    ],
    [
      [{ name: "OPENAI_API_KEY", why: "x" }],
      "list `openai` under providers instead",
    ],
    [
      [{ name: "X_MCP_TOKEN", why: "x" }],
      "give the app's setting another name",
    ],
    [
      [{ name: "a-b", why: "x" }],
      "binding names must be JavaScript identifiers",
    ],
  ])("refuses %j", (settings, message) => {
    expect(strict(settings)).toThrow(message);
  });

  it("refuses a name that is a binding or a secret too", () => {
    expect(
      strict([{ name: "DB", why: "x" }], { resources: { d1: ["DB"] } }),
    ).toThrow(
      "settings: DB is one of the app's bindings; pick another name for the setting",
    );
    expect(strict([{ name: "KEY", why: "x" }], { secrets: ["KEY"] })).toThrow(
      "settings: KEY is one of the app's secrets too",
    );
  });

  it("is tolerated by the lenient schema with unknown fields", () => {
    expect(
      validateManifest({ id: "mc", settings: [{ name: "A", future: 1 }] })
        .settings,
    ).toEqual([{ name: "A", future: 1 }]);
    expect(() =>
      validateManifest({ id: "mc", settings: [{ name: "not a name" }] }),
    ).toThrow();
  });

  it("is refused for third-party apps", () => {
    expect(
      manifestTierProblems({ settings: [{ name: "A" }] }, "dispatch"),
    ).toContain(
      "settings: third-party apps can't have settings of their own yet",
    );
  });
});
