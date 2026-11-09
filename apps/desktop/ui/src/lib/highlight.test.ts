import { describe, expect, it } from "vitest";
import { snippetParts } from "./highlight";

const marked = (text: string, ranges: { start: number; end: number }[]) =>
  snippetParts(text, ranges)
    .map((p) => (p.match ? `[${p.text}]` : p.text))
    .join("");

describe("snippetParts", () => {
  it("marks each [start, end) range and keeps every character", () => {
    expect(
      marked("…pricing for forty seats…", [
        { start: 1, end: 8 },
        { start: 13, end: 18 },
      ]),
    ).toBe("…[pricing] for [forty] seats…");
    expect(
      snippetParts("abc", [])
        .map((p) => p.text)
        .join(""),
    ).toBe("abc");
  });

  it("tidies unordered, overlapping and out-of-bounds ranges", () => {
    expect(
      marked("abcdef", [
        { start: 3, end: 5 },
        { start: 0, end: 2 },
      ]),
    ).toBe("[ab]c[de]f");
    expect(
      marked("abcdef", [
        { start: 1, end: 4 },
        { start: 2, end: 5 },
      ]),
    ).toBe("a[bcde]f");
    expect(
      marked("abc", [
        { start: -4, end: 1 },
        { start: 2, end: 99 },
      ]),
    ).toBe("[a]b[c]");
    expect(
      marked("abc", [
        { start: 2, end: 2 },
        { start: Number.NaN, end: 3 },
      ]),
    ).toBe("abc");
  });

  it("uses UTF-16 offsets, as the server sends them", () => {
    // "é" is one code unit; an emoji is two.
    const text = "café 👋 hello";
    const start = text.indexOf("hello");
    expect(marked(text, [{ start, end: start + 5 }])).toBe("café 👋 [hello]");
  });
});
