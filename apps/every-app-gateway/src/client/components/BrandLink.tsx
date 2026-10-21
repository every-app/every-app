import { Link } from "@tanstack/react-router";
import { cn } from "cn";

/**
 * The Every App mark and wordmark, linking home. The mark is as wide as the
 * sidebar's icon column, so the wordmark starts where the nav labels do.
 */
export function BrandLink({
  className,
  onClick,
}: {
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Link
      to="/"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 text-lg font-semibold tracking-tight",
        className,
      )}
    >
      <img
        src="/android-chrome-192x192.png"
        alt=""
        className="size-6 rounded-md"
      />
      Every App
    </Link>
  );
}
