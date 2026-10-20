import { useState } from "react";
import { cn } from "cn";
import type { UserAccessApp } from "@/types/app";

/** Use the app's own favicon, keeping the icon's space when it is missing. */
export function AppIcon({
  app,
  className,
}: {
  app: Pick<UserAccessApp, "name" | "hostname" | "status">;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src =
    app.hostname && app.status === "active"
      ? `//${app.hostname}/favicon.ico`
      : null;

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground/5 text-lg font-medium",
        className,
      )}
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          className="size-full object-contain"
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        (Array.from(app.name.trim())[0]?.toUpperCase() ?? "?")
      )}
    </span>
  );
}
