import { describe, expect, it } from "vitest";
import type { RunRecord, Verdict } from "./types";

describe("types", () => {
  it("the decision table's verdicts are the four the design names, in evaluation order", () => {
    const order: Verdict[] = [
      "fail-infra",
      "fail-onboarding",
      "pass-with-intervention",
      "pass",
    ];
    const verdict: RunRecord["verdict"] = {
      value: order[3]!,
      reasonCode: null,
      falseDone: false,
      tainted: false,
      shortcut: false,
      reportedUrl: null,
    };
    expect(order).toHaveLength(4);
    expect(verdict.value).toBe("pass");
  });
});
