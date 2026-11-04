import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The frame of every page in the app shell: the same inset on every page,
 * one reading width, and one gap between the header and what follows. The
 * page starts 20px down, like the sidebar's brand row, so a page title and
 * the brand share a center line.
 */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 py-5 pb-safe md:px-10 lg:px-12">
      <div className="mx-auto max-w-7xl space-y-6">{children}</div>
    </div>
  );
}

/**
 * The page title, with an optional subtitle and actions on the right. The
 * title line is a control's height (40px), so the actions center on the
 * title whether or not a subtitle follows it.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  /** One plain sentence on what this does, only for what's specific to the Gateway. */
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <h1 className="flex min-h-10 items-center gap-2 text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The heading of one section on a page, with an optional hint and action.
 * At `level` 2 the row is a title and hint's height (44px) with or without a
 * hint, so what follows starts at the same place from one page to the next.
 * The actions go under the heading on a phone, so neither squeezes the other.
 */
export function SectionHeader({
  title,
  hint,
  action,
  level = 2,
}: {
  title: ReactNode;
  /** One plain sentence on what this does, only for what's specific to the Gateway; a link in it is underlined. */
  hint?: ReactNode;
  action?: ReactNode;
  /** 2 for a section of the page, 3 for a group inside one. */
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        level === 2 && "sm:min-h-11",
      )}
    >
      <div className="max-w-3xl min-w-0">
        <Heading
          className={
            level === 2 ? "text-base font-semibold" : "text-sm font-medium"
          }
        >
          {title}
        </Heading>
        {hint ? (
          <p className="text-sm text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
