import { useState } from "react";
import { cn } from "cn";
import type { UserAccessApp } from "@/types/app";

/**
 * The launcher icon the app's manifest names, else the app's favicon, else
 * the first letter of its name: an image that fails to load gives way to
 * the next. The Gateway's own address comes first (`/app-icon/<hostname>`,
 * server/app-icon.ts: the manifest's icon, else the favicon, read from the
 * app's Worker), since the app's host is behind Cloudflare Access and
 * answers only a browser that opened the app lately. The app's host stays
 * as the next try, for an icon the Gateway doesn't serve (one the app's
 * code answers, not a static file; a third-party app's). The app draws its
 * icon's whole tile; this only rounds its corners.
 */
export function AppIcon({
  app,
  className,
}: {
  app: Pick<UserAccessApp, "name" | "hostname" | "status" | "icon">;
  className?: string;
}) {
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const src =
    app.hostname && app.status === "active"
      ? [
          `/app-icon/${app.hostname}`,
          ...[app.icon, "/favicon.ico"]
            .filter((path): path is string => path !== null)
            .map((path) => `//${app.hostname}${path}`),
        ].find((candidate) => !failedSrcs.has(candidate))
      : undefined;

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground/5 text-lg font-medium",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="size-full object-contain"
          decoding="async"
          onError={() => setFailedSrcs((failed) => new Set(failed).add(src))}
        />
      ) : (
        (Array.from(app.name.trim())[0]?.toUpperCase() ?? "?")
      )}
    </span>
  );
}
