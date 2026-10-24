import { useEffect, useRef } from "react";
import { appNeedsSetup } from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/**
 * `?setup=<appId>` on the launcher: where the perimeter sends someone who
 * tried to open an app that needs setup, and where the sidebar's pinned
 * apps lead. Once the list is in, `open` gets that app if it still needs
 * setup, and `strip` removes the param either way (a ready or unknown app
 * just loses it). Handled once per value: stripping takes a render, and
 * the same id arriving again later is a new request.
 */
export function useSetupParam({
  setupParam,
  apps,
  loaded,
  open,
  strip,
}: {
  setupParam: string | undefined;
  apps: UserAccessApp[];
  /** The list is in: neither loading nor failed. */
  loaded: boolean;
  open: (app: UserAccessApp) => void;
  strip: () => void;
}) {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!setupParam) {
      handled.current = null;
      return;
    }
    if (handled.current === setupParam || !loaded) return;
    handled.current = setupParam;
    const app = apps.find(
      (app) => app.appId === setupParam && appNeedsSetup(app),
    );
    if (app) open(app);
    strip();
  }, [setupParam, apps, loaded, open, strip]);
}
