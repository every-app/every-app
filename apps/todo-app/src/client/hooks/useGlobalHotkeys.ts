import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { NEW_TODO_INPUT_ID } from "@/client/lib/element-ids";

interface UseGlobalHotkeysOptions {
  onShowShortcuts: () => void;
}

/**
 * Global keyboard shortcuts for the app.
 * Handles navigation (g>t, g>h), create (c), and show shortcuts (meta+slash).
 */
export function useGlobalHotkeys({ onShowShortcuts }: UseGlobalHotkeysOptions) {
  const navigate = useNavigate();
  const location = useLocation();

  // Show keyboard shortcuts modal (Cmd+/ or Ctrl+/)
  useHotkeys(
    "meta+slash",
    () => onShowShortcuts(),
    {
      preventDefault: true,
      enableOnFormTags: true,
    },
    [],
  );

  // Navigation: g then t -> Go to Todos
  useHotkeys("g>t", () => navigate({ to: "/" }), { preventDefault: true }, []);

  // Navigation: g then h -> Go to History
  useHotkeys(
    "g>h",
    () => navigate({ to: "/history" }),
    { preventDefault: true },
    [],
  );

  // Create new todo: c -> Focus input
  useHotkeys(
    "c",
    () => {
      if (location.pathname !== "/") {
        navigate({ to: "/" });
      }
      requestAnimationFrame(() => {
        const input = document.getElementById(NEW_TODO_INPUT_ID);
        input?.focus();
      });
    },
    { preventDefault: true },
    [location.pathname],
  );
}
