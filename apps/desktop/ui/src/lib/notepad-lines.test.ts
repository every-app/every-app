import { describe, expect, it } from "vitest";
import { parseLine } from "./notepad-lines";

const kinds = (line: string) => parseLine(line).map((p) => p.kind);

describe("parseLine", () => {
  it("keeps every character, so the textarea's caret lines up", () => {
    for (const line of [
      "- pricing",
      "    * nested item",
      "12. twelfth",
      "- [ ] todo",
      "- [x] done thing",
      "## Heading",
      "plain text - with a dash",
      "-not a bullet",
      "- ",
      "#nospace",
    ]) {
      expect(
        parseLine(line)
          .map((p) => p.text)
          .join(""),
      ).toBe(line);
    }
  });

  it("draws bullets, quiet markers, done tasks and headings", () => {
    expect(kinds("- pricing")).toEqual(["bullet", "text", "text"]);
    expect(kinds("  * nested")).toEqual(["indent", "bullet", "text", "text"]);
    expect(kinds("3. third")).toEqual(["marker", "text", "text"]);
    expect(kinds("- [ ] todo")).toEqual([
      "bullet",
      "text",
      "marker",
      "text",
      "text",
    ]);
    expect(kinds("- [x] shipped").at(-1)).toBe("done");
    expect(kinds("## Next steps")).toEqual(["marker", "text", "heading"]);
  });

  it("leaves text that only looks like markup alone", () => {
    expect(kinds("-not a bullet")).toEqual(["text"]);
    expect(kinds("#hashtag")).toEqual(["text"]);
    expect(kinds("")).toEqual([]);
  });
});
