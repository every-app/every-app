import { describe, expect, it } from "vitest";
import { extractDueDateFromInput, isFutureDueDate } from "./due-date-parser";

const NOW = new Date("2026-01-07T10:00:00.000Z"); // Wednesday

describe("extractDueDateFromInput", () => {
  it("extracts today keyword as due today", () => {
    const parsed = extractDueDateFromInput("Pay rent today", NOW);
    expect(parsed.title).toBe("Pay rent");
    expect(parsed.dueDate).toBe("2026-01-07");
  });

  it("extracts tomorrow from tom shorthand", () => {
    const parsed = extractDueDateFromInput("Call mom tom", NOW);
    expect(parsed.title).toBe("Call mom");
    expect(parsed.dueDate).toBe("2026-01-08");
  });

  it("extracts next week as monday", () => {
    const parsed = extractDueDateFromInput("Plan sprint next week", NOW);
    expect(parsed.title).toBe("Plan sprint");
    expect(parsed.dueDate).toBe("2026-01-12");
  });

  it("extracts on thursday to next thursday", () => {
    const parsed = extractDueDateFromInput("Submit report on thursday", NOW);
    expect(parsed.title).toBe("Submit report");
    expect(parsed.dueDate).toBe("2026-01-08");
  });

  it("extracts full weekday without on-prefix", () => {
    const parsed = extractDueDateFromInput("Prepare deck monday", NOW);
    expect(parsed.title).toBe("Prepare deck");
    expect(parsed.dueDate).toBe("2026-01-12");
  });

  it("extracts weekday in the middle and keeps trailing text", () => {
    const parsed = extractDueDateFromInput("Hello monday testing", NOW);
    expect(parsed.title).toBe("Hello testing");
    expect(parsed.dueDate).toBe("2026-01-12");
  });

  it("extracts abbreviated weekday without on-prefix", () => {
    const parsed = extractDueDateFromInput("Prepare deck mon", NOW);
    expect(parsed.title).toBe("Prepare deck");
    expect(parsed.dueDate).toBe("2026-01-12");
  });

  it("extracts abbreviated weekday in the middle and keeps trailing text", () => {
    const parsed = extractDueDateFromInput("Hello mon testing", NOW);
    expect(parsed.title).toBe("Hello testing");
    expect(parsed.dueDate).toBe("2026-01-12");
  });

  it("extracts friday full and abbreviated forms", () => {
    const full = extractDueDateFromInput("Book table friday", NOW);
    expect(full.title).toBe("Book table");
    expect(full.dueDate).toBe("2026-01-09");

    const abbreviated = extractDueDateFromInput("Book table fri", NOW);
    expect(abbreviated.title).toBe("Book table");
    expect(abbreviated.dueDate).toBe("2026-01-09");
  });

  it("extracts next weekday phrases", () => {
    const parsed = extractDueDateFromInput("Book flights next friday", NOW);
    expect(parsed.title).toBe("Book flights");
    expect(parsed.dueDate).toBe("2026-01-09");
  });

  it("extracts next weekday phrase in the middle and keeps trailing text", () => {
    const parsed = extractDueDateFromInput("Book next friday flights", NOW);
    expect(parsed.title).toBe("Book flights");
    expect(parsed.dueDate).toBe("2026-01-09");
  });

  it("extracts this weekend as saturday", () => {
    const parsed = extractDueDateFromInput("Clean garage this weekend", NOW);
    expect(parsed.title).toBe("Clean garage");
    expect(parsed.dueDate).toBe("2026-01-10");
  });

  it("extracts explicit on m-d-yy date", () => {
    const parsed = extractDueDateFromInput("Travel plans on 1-1-27", NOW);
    expect(parsed.title).toBe("Travel plans");
    expect(parsed.dueDate).toBe("2027-01-01");
  });

  it("extracts explicit date in the middle and keeps trailing text", () => {
    const parsed = extractDueDateFromInput("Travel on 1-1-27 plans", NOW);
    expect(parsed.title).toBe("Travel plans");
    expect(parsed.dueDate).toBe("2027-01-01");
  });

  it("does not extract weekday abbreviations embedded in larger words", () => {
    const parsed = extractDueDateFromInput("Call monica", NOW);
    expect(parsed.title).toBe("Call monica");
    expect(parsed.dueDate).toBeNull();
  });

  it("does not parse past explicit dates", () => {
    const parsed = extractDueDateFromInput("Pay bill on 1-1-25", NOW);
    expect(parsed.title).toBe("Pay bill on 1-1-25");
    expect(parsed.dueDate).toBeNull();
  });
});

describe("isFutureDueDate", () => {
  it("returns true only for dates after today", () => {
    expect(isFutureDueDate("2026-01-08", NOW)).toBe(true);
    expect(isFutureDueDate("2026-01-07", NOW)).toBe(false);
    expect(isFutureDueDate("2026-01-06", NOW)).toBe(false);
  });

  it("returns false for null or invalid input", () => {
    expect(isFutureDueDate(null, NOW)).toBe(false);
    expect(isFutureDueDate("not-a-date", NOW)).toBe(false);
  });
});
