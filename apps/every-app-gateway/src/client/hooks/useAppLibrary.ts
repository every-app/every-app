import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { z } from "zod";
import { toast } from "sonner";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";

export enum AppLibraryFilter {
  All = "all",
  Pinned = "pinned",
}

export enum AppLibraryLayout {
  Grid = "grid",
  List = "list",
}

export enum AppLibrarySort {
  Name = "name",
  Pinned = "pinned",
}

const preferencesSchema = z.object({
  pinnedIds: z.array(z.string()),
  layout: z.nativeEnum(AppLibraryLayout),
  sort: z.nativeEnum(AppLibrarySort),
});

type LibraryPreferences = z.infer<typeof preferencesSchema>;

const defaultPreferences: LibraryPreferences = {
  pinnedIds: [],
  layout: AppLibraryLayout.Grid,
  sort: AppLibrarySort.Name,
};

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Browser-local preferences are isolated by both user and organization. */
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
  const apps = useMemo(
    () => [...query.data].sort((a, b) => a.name.localeCompare(b.name)),
    [query.data],
  );
  const pinnedIds = useMemo(
    () => new Set(preferences.pinnedIds),
    [preferences.pinnedIds],
  );

  return {
    apps,
    isLoading: query.isLoading,
    isError: query.isError,
    pinnedIds,
    pinnedApps: apps.filter((app) => pinnedIds.has(app.id)),
    layout: preferences.layout,
    sort: preferences.sort,
    setLayout: (layout: AppLibraryLayout) => updatePreferences({ layout }),
    setSort: (sort: AppLibrarySort) => updatePreferences({ sort }),
    togglePin: (appId: string) =>
      updatePreferences({
        pinnedIds: pinnedIds.has(appId)
          ? preferences.pinnedIds.filter((id) => id !== appId)
          : [...preferences.pinnedIds, appId],
      }),
  };
}
