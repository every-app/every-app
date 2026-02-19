import { describe, expect, it } from "vitest";
import {
  findBestDateTokenMatch,
  findDateTokenMatches,
} from "./date-token-matcher";

describe("date-token-matcher", () => {
  it("matches today keyword", () => {
    const match = findBestDateTokenMatch("Pay rent today");
    expect(match).toMatchObject({
      matchedText: "today",
      kind: "today",
    });
  });

  it("matches weekday abbreviation in the middle", () => {
    const match = findBestDateTokenMatch("Hello mon testing");
    expect(match).toMatchObject({
      matchedText: "mon",
      start: 6,
      end: 9,
      kind: "weekday",
    });
  });

  it("prefers longer phrase over overlapping weekday", () => {
    const match = findBestDateTokenMatch("Book next friday flights");
    expect(match).toMatchObject({
      matchedText: "next friday",
      kind: "weekdayNext",
    });
  });

  it("matches numeric on-date phrase in the middle", () => {
    const match = findBestDateTokenMatch("Travel on 1-1-27 plans");
    expect(match).toMatchObject({
      matchedText: "on 1-1-27",
      kind: "numericOn",
      monthText: "1",
      dayText: "1",
      yearText: "27",
    });
  });

  it("does not match weekday abbreviations inside larger words", () => {
    const match = findBestDateTokenMatch("Call monica");
    expect(match).toBeNull();
  });

  it("returns non-overlapping matches", () => {
    const matches = findDateTokenMatches("mon then next friday");
    expect(matches.map((m) => m.matchedText)).toEqual(["mon", "next friday"]);
  });
});
