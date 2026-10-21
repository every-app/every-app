import { useEffect, useState } from "react";

/**
 * How this device writes a modifier shortcut for `key`: "⌘K" on Apple
 * platforms, "Ctrl K" elsewhere. Null until mounted, since the server can't
 * know.
 */
export function useShortcutLabel(key: string): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(
      /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
        ? `⌘${key}`
        : `Ctrl ${key}`,
    );
  }, [key]);
  return label;
}
