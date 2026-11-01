import { useEffect, useRef } from "react";
import { appNeedsSetup, mcpAppUsable } from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/**
 * A one-shot `?<param>=<appId>` on the launcher that opens one app's
 * dialog. Once the list is in, `open` gets that app if `matches` still
 * holds for it, and `strip` removes the param either way (an app that no
 * longer matches, or an unknown one, just loses it). Handled once per
 * value: stripping takes a render, and the same id arriving again later
 * is a new request.
 */
function useAppParam({
  value,
  apps,
  loaded,
  matches,
  open,
  strip,
}: {
  value: string | undefined;
  apps: UserAccessApp[];
  /** The list is in: neither loading nor failed. */
  loaded: boolean;
  matches: (app: UserAccessApp) => boolean;
  open: (app: UserAccessApp) => void;
  strip: () => void;
}) {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!value) {
      handled.current = null;
      return;
    }
    if (handled.current === value || !loaded) return;
    handled.current = value;
    const app = apps.find((app) => app.appId === value && matches(app));
    if (app) open(app);
    strip();
  }, [value, apps, loaded, matches, open, strip]);
}

/**
 * `?setup=<appId>`: where the perimeter sends someone who tried to open an
 * app that needs setup, and where the sidebar's pinned apps lead. Opens
 * the setup dialog if the app still needs setup.
 */
export function useSetupParam({
  setupParam,
  ...rest
}: {
  setupParam: string | undefined;
  apps: UserAccessApp[];
  loaded: boolean;
  open: (app: UserAccessApp) => void;
  strip: () => void;
}) {
  useAppParam({ value: setupParam, matches: appNeedsSetup, ...rest });
}

/**
 * `?mcp=<appId>`: where a pinned MCP app in the sidebar leads. Opens the
 * "Use it from your agent" dialog if the app is still an MCP app that is
 * set up.
 */
export function useMcpParam({
  mcpParam,
  ...rest
}: {
  mcpParam: string | undefined;
  apps: UserAccessApp[];
  loaded: boolean;
  open: (app: UserAccessApp) => void;
  strip: () => void;
}) {
  useAppParam({ value: mcpParam, matches: mcpAppUsable, ...rest });
}
