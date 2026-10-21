import { useState } from "react";
import { cn } from "cn";
import type { UserAccessApp } from "@/types/app";

/**
 * The launcher icon the app's manifest names, else the app's favicon, else
 * the first letter of its name: an image that fails to load gives way to
 * the next. The app draws its icon's whole tile; this only rounds its
 * corners.
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
      ? [app.icon, "/favicon.ico"]
          .filter((path): path is string => path !== null)
          .map((path) => `//${app.hostname}${path}`)
          .find((candidate) => !failedSrcs.has(candidate))
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
