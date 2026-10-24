import type { ReactNode } from "react";

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
  /** A subtitle, or metadata such as a `<dl>`. */
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

/** The heading of one section on a page, with an optional hint and action. */
export function SectionHeader({
  title,
  hint,
  action,
}: {
  title: string;
  /** One line under the title; a link in it is underlined. */
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {hint ? (
          <p className="text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
