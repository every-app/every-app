// A quiet message at the bottom of the window ("Couldn't save the notes."), gone after a few
// seconds. Any code can call notify().

import { useEffect, useSyncExternalStore } from "react";

let current: { id: number; text: string; tone: "info" | "error" } | null = null;
const listeners = new Set<() => void>();
let next = 0;

function emit() {
  for (const l of listeners) l();
}

export function notify(text: string, tone: "info" | "error" = "info"): void {
  current = { id: ++next, text, tone };
  emit();
}

export function Notice() {
  const notice = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      if (current?.id === notice.id) {
        current = null;
        emit();
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="animate-in fade-in-0 slide-in-from-bottom-2 pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-4 py-2 text-[13px] shadow-lg"
    >
      <span className={notice.tone === "error" ? "text-destructive" : undefined}>{notice.text}</span>
    </div>
  );
}
