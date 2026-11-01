import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { z } from "zod";
import { toast } from "sonner";
import { useSession } from "@/client/hooks/useSession";
import { DEPLOYING_POLL_MS, hasDeployingApp } from "@/client/lib/appStatus";
import {
  userAppsCollection,
  useQueryFailed,
  useQueryPending,
} from "@/client/tanstack-db";

export enum AppLibraryLayout {
  Grid = "grid",
  List = "list",
}

// Unknown keys (the sort preference of earlier builds) are dropped.
const preferencesSchema = z.object({
  pinnedIds: z.array(z.string()),
  layout: z.enum(AppLibraryLayout),
});

type LibraryPreferences = z.infer<typeof preferencesSchema>;

const defaultPreferences: LibraryPreferences = {
  pinnedIds: [],
  layout: AppLibraryLayout.Grid,
};

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * The apps the person can open, pinned ones first and then by name: the one
 * order the library and the sidebar share. Browser-local preferences are
 * isolated by both user and organization.
 */
export function useAppLibrary() {
  const { data: session } = useSession();
  const storageKey =
    session?.user.id && session.session.activeOrganizationId
      ? `app-library:${session.user.id}:${session.session.activeOrganizationId}`
      : null;
  const readSnapshot = useCallback(() => {
    if (!storageKey) return null;
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, [storageKey]);
  const stored = useSyncExternalStore(subscribe, readSnapshot, () => null);
  const preferences = useMemo(() => {
    if (!stored) return defaultPreferences;
    try {
      return preferencesSchema.parse(JSON.parse(stored));
    } catch (error) {
      console.error("Invalid app library preferences", error);
      return defaultPreferences;
    }
  }, [stored]);

  const updatePreferences = (changes: Partial<LibraryPreferences>) => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ ...preferences, ...changes }),
      );
      // Storage events normally notify other tabs, so also notify this tab.
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
    } catch {
      toast.error("Your browser could not save your app preferences.");
    }
  };

  const query = useLiveQuery((q) => q.from({ app: userAppsCollection }));
  // The collection stays "ready" when its fetch fails, and keeps its rows
  // while its query is reset by an organization switch: ask the query itself.
  const failed = useQueryFailed(["user-apps"]);
  const pending = useQueryPending(["user-apps"]);
  // Until the collection has synced once it is empty, not loading: a count
  // read then would say 0. While the query is pending the rows are the
  // previous organization's, so nothing lists them.
  const isLoading = (!query.isReady && !query.isError) || pending;
  const pinnedIds = useMemo(
    () => new Set(preferences.pinnedIds),
    [preferences.pinnedIds],
  );
  const apps = useMemo(
    () =>
      isLoading
        ? []
        : [...query.data].sort(
            (a, b) =>
              Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)) ||
              a.name.localeCompare(b.name),
          ),
    [isLoading, query.data, pinnedIds],
  );
  // While an app is deploying, read the list again every few seconds: each
  // read probes the app on the server, so the card turns into a link as
  // soon as the Gateway reaches its Worker, and "Deploying" never outlives
  // the deploy on a page left open.
  const deploying = hasDeployingApp(apps);
  useEffect(() => {
    if (!deploying) return;
    const timer = window.setInterval(() => {
      void userAppsCollection.utils.refetch();
    }, DEPLOYING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [deploying]);

  return {
    apps,
    isLoading,
    isError: query.isError || failed,
    pinnedIds,
    pinnedApps: apps.filter((app) => pinnedIds.has(app.id)),
    layout: preferences.layout,
    setLayout: (layout: AppLibraryLayout) => updatePreferences({ layout }),
    togglePin: (appId: string) =>
      updatePreferences({
        pinnedIds: pinnedIds.has(appId)
          ? preferences.pinnedIds.filter((id) => id !== appId)
          : [...preferences.pinnedIds, appId],
      }),
  };
}
