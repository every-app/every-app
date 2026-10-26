import { describe, expect, it } from "vitest";
import {
  appSettings,
  appWorkerNames,
  evaluateAppSettings,
  settingEntries,
  settingValueProblem,
  settingValueTakes,
} from "./appSettings.js";

const manifest = {
  secrets: ["MAIN_SECRET"],
  settings: [
    {
      name: "POSTHOG_HOST",
      why: "Where events go.",
      type: "url" as const,
      default: "https://us.i.posthog.com",
    },
    {
      name: "POSTHOG_PROJECT_ID",
      why: "Which project.",
      type: "number" as const,
    },
    {
      name: "REGION",
      why: "Where data lives.",
      values: ["us", "eu"],
      optional: true,
    },
  ],
};

describe("an app's plain settings", () => {
  it("are app-held settings after the secrets, with their rule", () => {
    const settings = appSettings(manifest);
    expect(
      settings.map((setting) => [setting.kind, setting.id, setting.holder]),
    ).toEqual([
      ["secret", "MAIN_SECRET", "app"],
      ["setting", "POSTHOG_HOST", "app"],
      ["setting", "POSTHOG_PROJECT_ID", "app"],
      ["setting", "REGION", "app"],
    ]);
    expect(settings[1]!.value).toEqual({
      type: "url",
      default: "https://us.i.posthog.com",
    });
    expect(settings[3]!.value).toEqual({ type: "text", values: ["us", "eu"] });
    expect(settings[0]!.value).toBeUndefined();
  });

  it("need: required by default, optional with a default (the deploy writes it) or when marked", () => {
    const needs = appSettings(manifest).map((setting) => setting.need.kind);
    expect(needs).toEqual(["required", "optional", "required", "optional"]);
    const report = evaluateAppSettings(
      appSettings(manifest),
      (_holder, name) => name === "MAIN_SECRET",
    );
    expect(report.unmet.map((setting) => setting.id)).toEqual([
      "POSTHOG_PROJECT_ID",
    ]);
  });

  it("go on the app's Workers with its secrets", () => {
    expect(appWorkerNames(manifest)).toEqual([
      "MAIN_SECRET",
      "POSTHOG_HOST",
      "POSTHOG_PROJECT_ID",
      "REGION",
    ]);
  });

  it("read a stored manifest's entries tolerantly", () => {
    expect(
      settingEntries({
        settings: [
          { name: "A", type: "weird" as never, values: [1] as never },
          { nope: true } as never,
        ],
      }),
    ).toEqual([{ name: "A" }]);
  });
});

describe("settingValueProblem and settingValueTakes", () => {
  it.each([
    [{ type: "url" as const }, "https://eu.i.posthog.com", null],
    [
      { type: "url" as const },
      "eu.i.posthog.com",
      '"eu.i.posthog.com" isn\'t an http or https URL.',
    ],
    [
      { type: "url" as const },
      "ftp://x.example",
      '"ftp://x.example" isn\'t an http or https URL.',
    ],
    [{ type: "number" as const }, "12345", null],
    [{ type: "number" as const }, "-1.5", null],
    [{ type: "number" as const }, "12a", '"12a" isn\'t a number.'],
    [{ type: "boolean" as const }, "true", null],
    [{ type: "boolean" as const }, "yes", "Not true or false."],
    [{ type: "text" as const, values: ["us", "eu"] }, "eu", null],
    [{ type: "text" as const, values: ["us", "eu"] }, "EU", "Not us or eu."],
    [{ type: "text" as const }, "  ", "Enter a value."],
  ])("%j %j", (rule, value, problem) => {
    expect(settingValueProblem(rule, value)).toBe(problem);
  });

  it("says what each takes", () => {
    expect(
      settingValueTakes({ type: "url", default: "https://us.i.posthog.com" }),
    ).toBe("an http or https URL, default https://us.i.posthog.com");
    expect(settingValueTakes({ type: "text", values: ["a", "b", "c"] })).toBe(
      "one of a, b or c",
    );
    expect(settingValueTakes({ type: "text" })).toBe("any text");
  });
});
