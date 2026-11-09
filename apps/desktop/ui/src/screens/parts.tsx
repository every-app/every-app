import { cn } from "cn";
import { AlertCircle, Users } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { dayLabel, groupByDay, timeOfDay } from "../lib/dates";
import type { MeetingRow } from "../types";

/** The scrolling content column of a screen. */
export function ScreenBody({
  children,
  className,
  width = "default",
}: {
  children: ReactNode;
  className?: string;
  width?: "default" | "wide" | "full";
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex flex-col gap-8 px-10 pb-16 pt-2",
          width === "default" && "max-w-[720px]",
          width === "wide" && "max-w-[960px]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ScreenTitle({
  children,
  subtitle,
  actions,
}: {
  children: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 pt-2">
      <div className="min-w-0">
        <h1 className="truncate text-[26px] font-semibold tracking-[-0.02em]">
          {children}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2 pt-1">{actions}</div>}
    </header>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "mb-2 text-[12px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </h2>
  );
}

/** A quiet message where content would be. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <p className="text-[14px] font-medium">{title}</p>
      {children && (
        <p className="max-w-sm text-balance text-[13px] text-muted-foreground">
          {children}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-[13px]",
        className,
      )}
    >
      <AlertCircle className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-foreground/80">{message}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy className="flex flex-col gap-1" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton
            className="h-3.5 flex-1"
            style={{ maxWidth: `${60 - i * 7}%` }}
          />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

const statusLabel: Partial<Record<MeetingRow["status"], string>> = {
  recording: "Recording",
  processing: "Writing notes",
  failed: "Notes failed",
};

export function ownerLabel(meeting: Pick<MeetingRow, "ownerEmail">): string {
  return meeting.ownerEmail?.split("@")[0] ?? "a teammate";
}

/** Meetings grouped under day headings, newest first. */
export function MeetingList({
  meetings,
  onOpen,
  now,
  showOwner = false,
  grouping = "day",
}: {
  meetings: MeetingRow[];
  onOpen: (id: string) => void;
  now?: Date;
  showOwner?: boolean;
  /** "day": under day headings; "flat": one list with the date on each row. */
  grouping?: "day" | "flat";
}) {
  const days =
    grouping === "day"
      ? groupByDay(meetings, (meeting) => meeting.startsAt)
      : [{ day: "all", date: new Date(0), items: meetings }];
  return (
    <div className="flex flex-col gap-6">
      {days.map((day) => (
        <section key={day.day}>
          {grouping === "day" && (
            <SectionLabel className="px-3">
              {dayLabel(day.date, now)}
            </SectionLabel>
          )}
          <ul className="flex flex-col">
            {day.items.map((meeting) => (
              <li key={meeting.id}>
                <button
                  type="button"
                  onClick={() => onOpen(meeting.id)}
                  className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">
                      {meeting.title}
                    </span>
                    <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      {showOwner && !meeting.mine && (
                        <span>{ownerLabel(meeting)}</span>
                      )}
                      {meeting.visibility === "team" && meeting.mine && (
                        <span className="inline-flex items-center gap-1">
                          <Users className="size-3" />
                          Team
                        </span>
                      )}
                      {meeting.attendeeCount > 1 && (
                        <span>{meeting.attendeeCount} people</span>
                      )}
                    </span>
                  </span>
                  {statusLabel[meeting.status] && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[12px]",
                        meeting.status === "recording"
                          ? "text-record"
                          : meeting.status === "failed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      {meeting.status === "recording" && (
                        <span className="record-pulse size-1.5 rounded-full bg-record" />
                      )}
                      {statusLabel[meeting.status]}
                    </span>
                  )}
                  <span className="w-24 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                    {grouping === "day"
                      ? timeOfDay(meeting.startsAt)
                      : dayLabel(new Date(meeting.startsAt), now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "12:04" or "1:02:09" from milliseconds. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
