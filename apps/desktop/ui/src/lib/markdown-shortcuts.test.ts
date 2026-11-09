import { describe, expect, it } from "vitest";
import { markdownShortcut, type Edit } from "./markdown-shortcuts";

const key = (k: string, extra: { shift?: boolean; meta?: boolean } = {}) => ({
  key: k,
  shift: extra.shift ?? false,
  meta: extra.meta ?? false,
});

function apply(value: string, edit: Edit | null): string {
  if (!edit) return value;
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to);
}

describe("markdownShortcut", () => {
  it("continues a bullet list on Enter", () => {
    const value = "- pricing";
    const edit = markdownShortcut(
      value,
      value.length,
      value.length,
      key("Enter"),
    );
    expect(apply(value, edit)).toBe("- pricing\n- ");
    expect(edit?.selStart).toBe(value.length + 3);
  });

  it("numbers the next item and keeps the indent", () => {
    const value = "  3. third";
    expect(
      apply(
        value,
        markdownShortcut(value, value.length, value.length, key("Enter")),
      ),
    ).toBe("  3. third\n  4. ");
  });

  it("continues a task list with an empty box", () => {
    const value = "- [x] done";
    expect(
      apply(
        value,
        markdownShortcut(value, value.length, value.length, key("Enter")),
      ),
    ).toBe("- [x] done\n- [ ] ");
  });

  it("ends the list on an empty item", () => {
    const value = "- a\n- ";
    const edit = markdownShortcut(
      value,
      value.length,
      value.length,
      key("Enter"),
    );
    expect(apply(value, edit)).toBe("- a\n");
  });

  it("leaves Enter alone outside lists", () => {
    expect(markdownShortcut("hello", 5, 5, key("Enter"))).toBeNull();
  });

  it("indents and outdents list items with Tab", () => {
    const value = "- a\n- b";
    const indented = apply(value, markdownShortcut(value, 7, 7, key("Tab")));
    expect(indented).toBe("- a\n  - b");
    expect(
      apply(
        indented,
        markdownShortcut(indented, 9, 9, key("Tab", { shift: true })),
      ),
    ).toBe(value);
  });

  it("wraps the selection in bold with ⌘B", () => {
    const value = "make this bold";
    const edit = markdownShortcut(value, 10, 14, key("b", { meta: true }));
    expect(apply(value, edit)).toBe("make this **bold**");
    expect([edit?.selStart, edit?.selEnd]).toEqual([12, 16]);
  });
});
