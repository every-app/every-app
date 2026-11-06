/**
 * What `--placement` takes, and what each choice is in the Gateway's Build
 * Output, checked with the schema cf itself reads that output with.
 */
import { OutputWorkerSchema } from "@cloudflare/config";
import { describe, expect, it } from "vitest";
import { parsePlacement, placementConfig } from "./placement";

describe("parsePlacement", () => {
  it.each(["smart", "off", "aws:us-east-1", "aws:ap-south-1", "gcp:europe-west1", "azure:westeurope"])(
    "takes %s",
    (value) => {
      expect(parsePlacement(value)).toBe(value);
    },
  );

  it("reads a value the way a person types it", () => {
    expect(parsePlacement("  SMART ")).toBe("smart");
    expect(parsePlacement("AWS:US-EAST-1")).toBe("aws:us-east-1");
  });

  it.each(["", "  ", "on", "near", "us-east-1", "aws:", ":us-east-1", "aws:us east 1", "aws:us_east_1", "aws:us-east-1:x", "foo:bar", "db:5432"])(
    "refuses %j, naming what it takes",
    (value) => {
      expect(() => parsePlacement(value)).toThrowError(
        expect.objectContaining({
          code: "INVALID_PLACEMENT",
          message: expect.stringContaining("--placement"),
          fix: expect.stringContaining("smart"),
        }),
      );
    },
  );
});

describe("placementConfig", () => {
  it.each([
    ["smart", { mode: "smart" }],
    ["off", { mode: "off" }],
    ["aws:ap-south-1", { region: "aws:ap-south-1" }],
  ])("%s", (placement, config) => {
    expect(placementConfig(placement)).toEqual(config);
  });

  it.each(["smart", "off", "gcp:europe-west1"])("%s is valid Build Output for cf", (placement) => {
    const parsed = OutputWorkerSchema.safeParse({
      name: "every-app-gateway",
      compatibilityDate: "2026-01-01",
      env: {},
      placement: placementConfig(placement),
    });
    expect(parsed.error?.issues.filter((issue) => issue.path[0] === "placement") ?? []).toEqual([]);
  });
});
