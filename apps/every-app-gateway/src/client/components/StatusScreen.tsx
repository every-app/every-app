import type { ReactNode } from "react";
import { cn } from "cn";
import { BrandMark } from "@/client/components/BrandLink";
import { Spinner } from "@/client/components/Spinner";

const WIDTHS = {
  sm: "max-w-xs",
  md: "max-w-lg",
  lg: "max-w-3xl",
};

/**
 * A state that fills the page: a spinner while the app finalizes or
 * redirects, a failure, or a gate. It centers its content and scrolls when
 * the content is taller than the page.
 */
export function StatusScreen({
  logo = false,
  title,
  description,
  pending = false,
  children,
  footer,
  size = "md",
}: {
  /** Show the Every App mark and wordmark, for screens outside the app shell. */
  logo?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  /** Show a spinner below the title. */
  pending?: boolean;
  /** Content below the text, such as an EmptyState, an Alert or a Card. It fills the width. */
  children?: ReactNode;
  footer?: ReactNode;
  /** The width of the content: `sm` for auth screens, `lg` for a wide card. */
  size?: keyof typeof WIDTHS;
}) {
  return (
    // The auto-margin child centers when it fits and stays reachable when it
    // is taller than the page. Plain `justify-center` would clip the overflow.
    <div className="flex h-full w-full flex-col items-center overflow-y-auto p-4 md:p-6">
      <div
        className={cn(
          "m-auto flex w-full flex-col items-center gap-4",
          WIDTHS[size],
        )}
      >
        {logo ? <BrandMark mark="size-8" /> : null}
        {title ? (
          <h1 className="text-center text-xl font-semibold">{title}</h1>
        ) : null}
        {pending ? <Spinner /> : null}
        {description ? (
          <p className="text-center text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {children}
        {footer ? (
          <div className="text-center text-xs text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
