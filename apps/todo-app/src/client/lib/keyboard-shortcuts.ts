/**
 * Centralized keyboard shortcuts configuration.
 * Single source of truth for both implementation and display in the shortcuts modal.
 */

type ShortcutSeparator = "then" | "or" | "plus";

interface ShortcutDefinition {
  /** Keys that trigger this shortcut (for display) */
  keys: string[];
  /** Human-readable description */
  description: string;
  /** How to display the keys (default: sequential) */
  separator?: ShortcutSeparator;
  /** The hotkey string for react-hotkeys-hook */
  hotkey: string;
}

interface ShortcutCategory {
  category: string;
  items: ShortcutDefinition[];
}

// Navigation shortcuts
const SHORTCUT_MOVE_DOWN: ShortcutDefinition = {
  keys: ["j", "↓"],
  description: "Move down",
  separator: "or",
  hotkey: "j, ArrowDown",
};

const SHORTCUT_MOVE_UP: ShortcutDefinition = {
  keys: ["k", "↑"],
  description: "Move up",
  separator: "or",
  hotkey: "k, ArrowUp",
};

const SHORTCUT_GO_TO_TODOS: ShortcutDefinition = {
  keys: ["g", "t"],
  description: "Go to Todos",
  hotkey: "g>t",
};

const SHORTCUT_GO_TO_HISTORY: ShortcutDefinition = {
  keys: ["g", "h"],
  description: "Go to History",
  hotkey: "g>h",
};

// Action shortcuts
const SHORTCUT_CREATE_TODO: ShortcutDefinition = {
  keys: ["c"],
  description: "Create new todo",
  hotkey: "c",
};

const SHORTCUT_TOGGLE_COMPLETE: ShortcutDefinition = {
  keys: ["d"],
  description: "Toggle completion",
  hotkey: "d",
};

const SHORTCUT_DELETE_TODO: ShortcutDefinition = {
  keys: ["x"],
  description: "Delete todo",
  hotkey: "x",
};

const SHORTCUT_SAVE_EDIT: ShortcutDefinition = {
  keys: ["Enter"],
  description: "Save edit",
  hotkey: "Enter",
};

const SHORTCUT_CANCEL_EDIT: ShortcutDefinition = {
  keys: ["Esc"],
  description: "Cancel edit",
  hotkey: "Escape",
};

// General shortcuts
const SHORTCUT_SHOW_SHORTCUTS: ShortcutDefinition = {
  keys: ["⌘", "/"],
  description: "Show keyboard shortcuts",
  separator: "plus",
  hotkey: "meta+slash",
};

// Used by useKeyboardNavigation
export const SHORTCUT_MOVE_DOWN_HOTKEY = SHORTCUT_MOVE_DOWN.hotkey;
export const SHORTCUT_MOVE_UP_HOTKEY = SHORTCUT_MOVE_UP.hotkey;
export const SHORTCUT_TOGGLE_COMPLETE_HOTKEY = SHORTCUT_TOGGLE_COMPLETE.hotkey;
export const SHORTCUT_DELETE_TODO_HOTKEY = SHORTCUT_DELETE_TODO.hotkey;

/**
 * All shortcuts organized by category for display in the modal
 */
export const KEYBOARD_SHORTCUTS: ShortcutCategory[] = [
  {
    category: "Navigation",
    items: [
      SHORTCUT_MOVE_DOWN,
      SHORTCUT_MOVE_UP,
      SHORTCUT_GO_TO_TODOS,
      SHORTCUT_GO_TO_HISTORY,
    ],
  },
  {
    category: "Actions",
    items: [
      SHORTCUT_CREATE_TODO,
      SHORTCUT_TOGGLE_COMPLETE,
      SHORTCUT_DELETE_TODO,
      SHORTCUT_SAVE_EDIT,
      SHORTCUT_CANCEL_EDIT,
    ],
  },
  {
    category: "General",
    items: [SHORTCUT_SHOW_SHORTCUTS],
  },
];
