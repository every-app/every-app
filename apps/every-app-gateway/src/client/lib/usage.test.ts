import { describe, expect, it } from "vitest";
import {
  formatCostMicros,
  formatCount,
  monthLabel,
  monthOptions,
  usageTargetLabel,
} from "./usage";

describe("usage formatting", () => {
  it("separates thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(12_345_678)).toBe("12,345,678");
  });

  it("shows cost with four decimals under a dollar, two from there", () => {
    expect(formatCostMicros(0)).toBe("$0.00");
    expect(formatCostMicros(2_500)).toBe("$0.0025");
    expect(formatCostMicros(999_940)).toBe("$0.9999");
    expect(formatCostMicros(1_000_000)).toBe("$1.00");
    expect(formatCostMicros(12_345_678)).toBe("$12.35");
  });

  it("names a month", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("nope")).toBe("nope");
  });

  it("offers this UTC month and the 11 before it, across a year boundary", () => {
    const options = monthOptions(new Date("2026-02-15T12:00:00Z"));
    expect(options).toHaveLength(12);
    expect(options[0]).toEqual({ value: "2026-02", label: "February 2026" });
    expect(options[1]?.value).toBe("2026-01");
    expect(options[2]?.value).toBe("2025-12");
    expect(options[11]).toEqual({ value: "2025-03", label: "March 2025" });
  });

  it("takes the UTC month on the last evening of a month", () => {
    expect(monthOptions(new Date("2026-10-31T23:30:00Z"))[0]?.value).toBe(
      "2026-10",
    );
  });
});

describe("usageTargetLabel", () => {
  it("names a provider or capability as the registries do, and an unknown target by its id", () => {
    expect(usageTargetLabel("ai", "openrouter")).toBe("OpenRouter");
    expect(usageTargetLabel("ai", "workers-ai")).toBe("Workers AI");
    expect(usageTargetLabel("capability", "dataforseo")).toBe("DataForSEO");
    expect(usageTargetLabel("capability", "email")).toBe("Email");
    expect(usageTargetLabel("capability", "not-a-capability")).toBe(
      "not-a-capability",
    );
    expect(usageTargetLabel("ai", "mystery")).toBe("mystery");
  });
});
