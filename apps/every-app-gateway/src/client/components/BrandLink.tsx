import { Link } from "@tanstack/react-router";
import { cn } from "cn";

/**
 * The Every App mark and wordmark with no link, for the pages outside the
 * app shell (sign-in, password reset, invitations, the 404), where home is
 * behind a sign-in. `mark` sizes the tile; the wordmark stays text-lg.
 */
export function BrandMark({
  className,
  mark = "size-6",
}: {
  className?: string;
  /** The tile's size class. */
  mark?: string;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-lg font-semibold tracking-tight",
        className,
      )}
    >
      <img
        src="/android-chrome-192x192.png"
        alt=""
        className={cn("rounded-md", mark)}
      />
      Every App
    </span>
  );
}

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
      className={cn("flex items-center", className)}
    >
      <BrandMark />
    </Link>
  );
}
