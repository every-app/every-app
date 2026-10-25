import { useCallback, useEffect, useState } from "react";
import { appNeedsSetup } from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/** How often the list is re-read while the setup dialog is open. */
export const SETUP_REFETCH_MS = 15_000;

type SetupListed = Pick<
  UserAccessApp,
  "id" | "hostname" | "status" | "setup" | "tier"
>;

/**
 * Which app's setup dialog is open, as the live list says. The id is kept
 * and the app looked up on every render, so the dialog shows the list's
 * latest `setup` and closes by itself once that app no longer needs setup
 * (the owner ran the command and came back) or has left the list. While
 * it is open the list is re-read every {@link SETUP_REFETCH_MS}: a setting
 * set from a terminal reaches the gateway with no event the browser sees,
 * and the collection otherwise refetches only when the tab regains
 * visibility. `refetch` must be stable (a module-level function).
 */
export function useSetupDialog<T extends SetupListed>(
  apps: readonly T[],
  refetch: () => unknown,
) {
  const [id, setId] = useState<string | null>(null);
  const listed = id === null ? undefined : apps.find((app) => app.id === id);
  const app = listed && appNeedsSetup(listed) ? listed : null;
  const isOpen = app !== null;
  // Once it has closed by itself, forget the id: the app needing setup
  // again later shouldn't reopen it unasked.
  useEffect(() => {
    if (id !== null && !isOpen) setId(null);
  }, [id, isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => void refetch(), SETUP_REFETCH_MS);
    return () => clearInterval(timer);
  }, [isOpen, refetch]);
  const open = useCallback((app: Pick<T, "id">) => setId(app.id), []);
  const close = useCallback(() => setId(null), []);
  return { app, open, close };
}
