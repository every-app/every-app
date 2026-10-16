import type { ReactNode } from "react";

/** The page title, with an optional subtitle and actions on the right. */
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
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}
