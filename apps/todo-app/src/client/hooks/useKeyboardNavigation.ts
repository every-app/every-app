import { useCallback, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  SHORTCUT_MOVE_DOWN_HOTKEY,
  SHORTCUT_MOVE_UP_HOTKEY,
  SHORTCUT_TOGGLE_COMPLETE_HOTKEY,
  SHORTCUT_DELETE_TODO_HOTKEY,
} from "@/client/lib/keyboard-shortcuts";

interface UseKeyboardNavigationOptions {
  /** Array of item IDs in display order */
  itemIds: string[];
  /** Function to get the DOM element ID from an item ID */
  getElementId: (id: string) => string;
  /** Callback when toggle is triggered on an item */
  onToggle?: (id: string) => void;
  /** Callback when delete is triggered on an item */
  onDelete?: (id: string) => void;
}

/**
 * Hook for keyboard navigation of todo lists.
 * Provides j/k (arrow keys) navigation, d for toggle, x for delete.
 *
 * After toggle, focus moves to the item that will be visually adjacent
 * by tracking the next item ID before the state change.
 */
export function useKeyboardNavigation({
  itemIds,
  getElementId,
  onToggle,
  onDelete,
}: UseKeyboardNavigationOptions) {
  // Use ref to track which ID to focus after toggle
  // This avoids the stale closure issue since the array changes after toggle
  const pendingFocusIdRef = useRef<string | null>(null);

  // Helper to get currently focused item ID
  const getFocusedItemId = useCallback(() => {
    const activeElement = document.activeElement;
    return itemIds.find((id) => {
      const item = document.getElementById(getElementId(id));
      return item === activeElement;
    });
  }, [itemIds, getElementId]);

  // Helper to focus item at specific index
  const focusItemAtIndex = useCallback(
    (index: number) => {
      if (itemIds.length === 0) return;
      const clampedIndex = Math.max(0, Math.min(itemIds.length - 1, index));
      const targetId = itemIds[clampedIndex];
      const targetItem = document.getElementById(getElementId(targetId));
      targetItem?.focus();
    },
    [itemIds, getElementId],
  );

  // Helper to focus a specific item by ID
  const focusItemById = useCallback(
    (id: string) => {
      const targetItem = document.getElementById(getElementId(id));
      targetItem?.focus();
    },
    [getElementId],
  );

  // Move down: j or ArrowDown
  useHotkeys(
    SHORTCUT_MOVE_DOWN_HOTKEY,
    () => {
      const currentId = getFocusedItemId();
      if (currentId === undefined) {
        focusItemAtIndex(0);
      } else {
        const currentIndex = itemIds.indexOf(currentId);
        focusItemAtIndex(currentIndex + 1);
      }
    },
    { preventDefault: true },
    [getFocusedItemId, focusItemAtIndex, itemIds],
  );

  // Move up: k or ArrowUp
  useHotkeys(
    SHORTCUT_MOVE_UP_HOTKEY,
    () => {
      const currentId = getFocusedItemId();
      if (currentId === undefined) {
        focusItemAtIndex(itemIds.length - 1);
      } else {
        const currentIndex = itemIds.indexOf(currentId);
        focusItemAtIndex(currentIndex - 1);
      }
    },
    { preventDefault: true },
    [getFocusedItemId, focusItemAtIndex, itemIds],
  );

  // Toggle completion: d
  useHotkeys(
    SHORTCUT_TOGGLE_COMPLETE_HOTKEY,
    () => {
      if (!onToggle) return;
      const currentId = getFocusedItemId();
      if (!currentId) return;

      const currentIndex = itemIds.indexOf(currentId);
      // Determine which item to focus after toggle:
      // - Prefer item above (currentIndex - 1)
      // - Fall back to item below (currentIndex + 1)
      // - If neither exists, no focus change
      let nextFocusId: string | null = null;
      if (currentIndex > 0) {
        nextFocusId = itemIds[currentIndex - 1];
      } else if (currentIndex < itemIds.length - 1) {
        nextFocusId = itemIds[currentIndex + 1];
      }

      // Store the ID to focus (not index, since indices will change)
      pendingFocusIdRef.current = nextFocusId;

      // Trigger the toggle
      onToggle(currentId);

      // Focus the next item after a microtask to allow React to re-render
      // Using requestAnimationFrame ensures we run after the DOM update
      requestAnimationFrame(() => {
        if (pendingFocusIdRef.current) {
          focusItemById(pendingFocusIdRef.current);
          pendingFocusIdRef.current = null;
        }
      });
    },
    { preventDefault: true },
    [getFocusedItemId, onToggle, itemIds, focusItemById],
  );

  // Delete: x
  useHotkeys(
    SHORTCUT_DELETE_TODO_HOTKEY,
    () => {
      if (!onDelete) return;
      const currentId = getFocusedItemId();
      if (currentId) {
        onDelete(currentId);
      }
    },
    { preventDefault: true },
    [getFocusedItemId, onDelete],
  );
}
