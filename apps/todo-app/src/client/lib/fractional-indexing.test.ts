import { describe, it, expect } from "vitest";
import {
  generateDefaultSortKey,
  generateSortKeyBetween,
} from "./fractional-indexing";

describe("fractional-indexing", () => {
  /**
   * Helper to sort an array of sort keys in descending order (like the UI does)
   */
  const sortDesc = (keys: string[]) =>
    [...keys].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  describe("generateDefaultSortKey", () => {
    it("generates unique keys for consecutive calls", () => {
      const keys = Array.from({ length: 10 }, () => generateDefaultSortKey());
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("generates increasing keys over time (newer = higher)", () => {
      const key1 = generateDefaultSortKey();
      const key2 = generateDefaultSortKey();
      expect(key2 > key1).toBe(true);
    });

    it("newer todos appear at top of DESC-sorted list", () => {
      const older = generateDefaultSortKey();
      const newer = generateDefaultSortKey();

      const sorted = sortDesc([older, newer]);
      expect(sorted[0]).toBe(newer); // Newer at top
      expect(sorted[1]).toBe(older); // Older below
    });
  });

  describe("generateSortKeyBetween", () => {
    describe("inserting at boundaries", () => {
      it("no bounds: returns a default key", () => {
        const key = generateSortKeyBetween(undefined, undefined);
        expect(typeof key).toBe("string");
        expect(key.length).toBeGreaterThan(0);
      });

      it("only upper bound (after): generates key below it", () => {
        const after = "m";
        const key = generateSortKeyBetween(undefined, after);
        expect(key < after).toBe(true);
      });

      it("only lower bound (before): generates key above it", () => {
        const before = "m";
        const key = generateSortKeyBetween(before, undefined);
        expect(key > before).toBe(true);
      });
    });

    describe("inserting between two keys", () => {
      it("generates key between two single chars", () => {
        const key = generateSortKeyBetween("a", "z");
        expect(key > "a").toBe(true);
        expect(key < "z").toBe(true);
      });

      it("generates key between adjacent chars", () => {
        const key = generateSortKeyBetween("a", "b");
        expect(key > "a").toBe(true);
        expect(key < "b").toBe(true);
      });

      it("generates key between multi-char strings", () => {
        const key = generateSortKeyBetween("abc", "abd");
        expect(key > "abc").toBe(true);
        expect(key < "abd").toBe(true);
      });

      it("handles prefix case (before is prefix of after)", () => {
        const key = generateSortKeyBetween("a", "ab");
        expect(key > "a").toBe(true);
        expect(key < "ab").toBe(true);
      });
    });

    describe("repeated insertions", () => {
      it("allows many insertions at the bottom", () => {
        let bottomKey = "zzz";
        const keys = [bottomKey];

        for (let i = 0; i < 10; i++) {
          const newKey = generateSortKeyBetween(undefined, bottomKey);
          expect(newKey < bottomKey).toBe(true);
          keys.push(newKey);
          bottomKey = newKey;
        }

        // All keys should be in descending order
        const sorted = sortDesc(keys);
        expect(sorted).toEqual(keys);
      });

      it("allows many insertions at the top", () => {
        let topKey = "aaa";
        const keys = [topKey];

        for (let i = 0; i < 10; i++) {
          const newKey = generateSortKeyBetween(topKey, undefined);
          expect(newKey > topKey).toBe(true);
          keys.unshift(newKey);
          topKey = newKey;
        }

        // All keys should be in descending order
        const sorted = sortDesc(keys);
        expect(sorted).toEqual(keys);
      });

      it("allows many insertions between two keys", () => {
        let lower = "a";
        const upper = "z";
        const keys = [lower, upper];

        for (let i = 0; i < 10; i++) {
          const newKey = generateSortKeyBetween(lower, upper);
          expect(newKey > lower).toBe(true);
          expect(newKey < upper).toBe(true);
          keys.splice(keys.length - 1, 0, newKey); // Insert before upper
          lower = newKey;
        }

        // All keys should be in ascending order (for the between insertions)
        const sorted = [...keys].sort();
        expect(sorted).toEqual(keys);
      });
    });
  });

  describe("real-world scenarios (DESC-sorted todo list)", () => {
    it("new todos appear at the top", () => {
      // Existing todos
      const existingKeys = ["mk3a", "mk39", "mk38"];

      // Add new todo
      const newKey = generateDefaultSortKey();
      const allKeys = [...existingKeys, newKey];

      // New key should be at top after DESC sort
      const sorted = sortDesc(allKeys);
      expect(sorted[0]).toBe(newKey);
    });

    it("uncompleting a todo moves it to the bottom", () => {
      // Active todos sorted DESC
      const activeTodos = ["mk3c", "mk3b", "mk3a"];
      const bottomKey = activeTodos[activeTodos.length - 1];

      // Uncomplete a todo - generate key below the bottom
      const newKey = generateSortKeyBetween(undefined, bottomKey);

      expect(newKey < bottomKey).toBe(true);

      // Verify it appears at bottom
      const sorted = sortDesc([...activeTodos, newKey]);
      expect(sorted[sorted.length - 1]).toBe(newKey);
    });

    it("dragging to top of list", () => {
      const todos = ["z", "y", "x", "w"];
      const topKey = todos[0];

      // Drag 'w' to top - need key > topKey
      const newKey = generateSortKeyBetween(topKey, undefined);

      expect(newKey > topKey).toBe(true);

      // 'w' with new key should be at top
      const sorted = sortDesc(["z", "y", "x", newKey]);
      expect(sorted[0]).toBe(newKey);
    });

    it("dragging to bottom of list", () => {
      const todos = ["z", "y", "x", "w"];
      const bottomKey = todos[todos.length - 1];

      // Drag 'z' to bottom - need key < bottomKey
      const newKey = generateSortKeyBetween(undefined, bottomKey);

      expect(newKey < bottomKey).toBe(true);

      // 'z' with new key should be at bottom
      const sorted = sortDesc([newKey, "y", "x", "w"]);
      expect(sorted[sorted.length - 1]).toBe(newKey);
    });

    it("dragging between two items", () => {
      // List in DESC order: ["z", "y", "x", "w"]
      // Drag 'z' to between 'y' and 'x'
      // Need key: x < newKey < y
      const newKey = generateSortKeyBetween("x", "y");

      expect(newKey > "x").toBe(true);
      expect(newKey < "y").toBe(true);

      // Verify position in sorted list
      const sorted = sortDesc([newKey, "y", "x", "w"]);
      expect(sorted).toEqual(["y", newKey, "x", "w"]);
    });

    it("handles complex reordering sequence", () => {
      const items = [
        { id: "1", sortKey: "e" },
        { id: "2", sortKey: "d" },
        { id: "3", sortKey: "c" },
        { id: "4", sortKey: "b" },
        { id: "5", sortKey: "a" },
      ];

      // Drag item 2 (d) to between item 4 (b) and item 5 (a)
      items[1].sortKey = generateSortKeyBetween("a", "b");
      items.sort((a, b) => (b.sortKey > a.sortKey ? 1 : -1));
      expect(items.map((i) => i.id)).toEqual(["1", "3", "4", "2", "5"]);

      // Drag item 1 (e) to between item 3 (c) and item 4 (b)
      items[0].sortKey = generateSortKeyBetween("b", "c");
      items.sort((a, b) => (b.sortKey > a.sortKey ? 1 : -1));
      expect(items.map((i) => i.id)).toEqual(["3", "1", "4", "2", "5"]);
    });

    it("handles keys with special characters from repeated bottom insertions", () => {
      // Simulates the "!" prefix chain from repeated uncomplete operations
      const keys = ["mk3a", "!mk3a", "!!mk3a", "!!!mk3a"];

      const sorted = sortDesc(keys);
      expect(sorted).toEqual(["mk3a", "!mk3a", "!!mk3a", "!!!mk3a"]);

      // Can still insert below the lowest
      const evenLower = generateSortKeyBetween(undefined, "!!!mk3a");
      expect(evenLower < "!!!mk3a").toBe(true);
    });

    it("handles keys with ~ suffix from repeated top insertions", () => {
      // Simulates the "~" suffix chain from repeated drag-to-top operations
      const keys = ["mk3a", "mk3a~", "mk3a~~", "mk3a~~~"];

      const sorted = sortDesc(keys);
      expect(sorted).toEqual(["mk3a~~~", "mk3a~~", "mk3a~", "mk3a"]);

      // Can still insert above the highest
      const evenHigher = generateSortKeyBetween("mk3a~~~", undefined);
      expect(evenHigher > "mk3a~~~").toBe(true);
    });
  });
});
