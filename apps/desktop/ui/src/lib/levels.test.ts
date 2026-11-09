import { describe, expect, it } from "vitest";
import { barHeights, meterLevel, smoothLevel } from "./levels";

describe("floating recorder meter", () => {
  it("follows the louder side and is 0 when silent", () => {
    expect(meterLevel(0, 0)).toBe(0);
    expect(meterLevel(0.1, 0.12)).toBe(0);
    expect(meterLevel(0.5, 0.1)).toBeCloseTo(meterLevel(0.1, 0.5));
    expect(meterLevel(0.5, 0.1)).toBeGreaterThan(0);
    expect(meterLevel(1, 0)).toBe(1);
    expect(meterLevel(Number.NaN, 0.3)).toBeGreaterThan(0);
  });

  it("rises fast, falls slowly, and settles", () => {
    const up = smoothLevel(0, 1);
    const down = smoothLevel(1, 0);
    expect(up).toBeGreaterThan(1 - down);
    let v = 1;
    for (let i = 0; i < 60; i++) v = smoothLevel(v, 0);
    expect(v).toBe(0);
  });

  it("draws flat bars when silent and taller ones when loud", () => {
    expect(new Set(barHeights(0))).toEqual(new Set([5]));
    const loud = barHeights(1);
    expect(Math.max(...loud)).toBe(18);
    expect(loud[1]).toBe(18);
    expect(loud.every((h) => h > 5)).toBe(true);
  });
});
