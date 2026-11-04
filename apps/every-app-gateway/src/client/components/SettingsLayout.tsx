import type { ComponentProps, ReactNode } from "react";
import { SectionHeader } from "@/client/components/PageHeader";
import { Skeleton } from "@/client/components/ui/skeleton";

// The parts every Manage workspace tab is built from, so each tab has the same
// gaps, surface and row height. The surface and the row height match a
// `DataTable`'s, so a list and a table on one page read as one family.

/** The white card a list or summary sits on: a `TableCard`'s surface. */
const SURFACE = "rounded-xl border border-border bg-card";

/** One tab: its sections, 32px apart. */
export function SettingsTab({ children }: { children: ReactNode }) {
  return <div className="space-y-8">{children}</div>;
}

/**
 * A heading and what it titles: 16px apart under a tab's heading, and 8px
 * under a sub-heading (`level` 3), which belongs closer to its one list.
 */
export function SettingsSection({
  children,
  ...header
}: ComponentProps<typeof SectionHeader> & { children: ReactNode }) {
  return (
    <section className={header.level === 3 ? "space-y-2" : "space-y-4"}>
      <SectionHeader {...header} />
      {children}
    </section>
  );
}

/** Rows on one surface. Children are `SettingsRow`s. */
export function SettingsList({
  label,
  children,
}: {
  /** The accessible name of the list. */
  label: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={`divide-y divide-border overflow-hidden ${SURFACE}`}
    >
      {children}
    </ul>
  );
}

/**
 * One row: a name with its detail on the left, a status and an action on the
 * right. The action's slot is kept even when empty, so the statuses line up
 * down a list, and across the lists on a page.
 */
export function SettingsRow({
  name,
  detail,
  status,
  action,
}: {
  name: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex min-h-13 flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{name}</p>
        {detail ? (
          <p className="text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-sm">
        {status}
        <div className="flex justify-end empty:hidden sm:min-w-18 sm:empty:block">
          {action}
        </div>
      </div>
    </li>
  );
}

/** A `SettingsList` while it loads: the same surface and row height. */
export function SettingsListSkeleton({ rows }: { rows: number }) {
  return (
    <ul aria-busy className={`divide-y divide-border ${SURFACE}`}>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex min-h-13 items-center px-4">
          <Skeleton className="h-4 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

/** One setting at a glance: a label, its value, a line of detail, and the action that changes it. */
export function SettingsSummary({
  label,
  value,
  detail,
  action,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 p-4 ${SURFACE}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="flex flex-wrap items-center gap-2 text-base font-semibold tabular-nums">
          {value}
        </div>
        {detail ? (
          <div className="text-xs text-muted-foreground">{detail}</div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
