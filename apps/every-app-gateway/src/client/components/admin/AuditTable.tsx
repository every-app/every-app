import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { auditSubjectLabel } from "@every-app/sdk/internal";
import { cn } from "cn";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell } from "@/client/components/table/DateCell";
import { Badge } from "@/client/components/ui/badge";
import type { AuditRow } from "@/types/audit";

interface AuditTableProps {
  events: AuditRow[];
  /** The first load: skeleton rows under the headers. */
  isLoading: boolean;
  /** A load failure, shown above the rows (or in their place). */
  error?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  /** True when a filter narrows the list; an empty table then offers to clear them. */
  isFiltered: boolean;
  onClearFilters: () => void;
}

/** The badge beside a non-person actor: what kind of thing acted. */
const KIND_BADGES: Record<string, string> = {
  agent: "AI app",
  operator: "CLI",
  app: "App",
  gateway: "Gateway",
};

/**
 * Who did it: a member by name (their email under it), an AI app by the
 * name it registered with, the CLI by its operator, an app by its id,
 * or the Gateway itself.
 */
function WhoCell({ actor }: { actor: AuditRow["actor"] }) {
  if (actor.kind === "user") {
    const name = actor.name ?? actor.email;
    // No account any more: by id, never by a profile kept elsewhere.
    if (name === null) {
      return (
        <>
          <p className="truncate text-muted-foreground">Former member</p>
          <p className="truncate text-xs text-muted-foreground">{actor.id}</p>
        </>
      );
    }
    return (
      <>
        <p className="truncate font-medium">{name}</p>
        {actor.email && actor.email !== name ? (
          <p className="truncate text-xs text-muted-foreground">
            {actor.email}
          </p>
        ) : null}
      </>
    );
  }
  const badge = KIND_BADGES[actor.kind] ?? actor.kind;
  const title =
    actor.kind === "gateway"
      ? "Gateway"
      : (actor.name ?? actor.email ?? actor.id ?? badge);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <p
        className={cn(
          "truncate",
          actor.kind === "gateway" ? "text-muted-foreground" : "font-medium",
        )}
      >
        {title}
      </p>
      {actor.kind !== "gateway" ? (
        <Badge variant="outline" size="sm" className="shrink-0">
          {badge}
        </Badge>
      ) : null}
    </div>
  );
}

/** What happened: the type in plain words, and the catalogue's one line under it. */
function WhatCell({ event }: { event: AuditRow }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate font-medium" title={event.type}>
          {event.label}
        </p>
        {event.appEvent ? (
          <Badge variant="secondary" size="sm" className="shrink-0">
            App event
          </Badge>
        ) : null}
      </div>
      <p
        className="truncate text-xs text-muted-foreground"
        title={event.summary}
      >
        {event.summary}
      </p>
    </>
  );
}

function SubjectCell({ subject }: { subject: AuditRow["subject"] }) {
  const label = auditSubjectLabel(subject);
  if (!label) return <span className="text-muted-foreground">—</span>;
  return (
    <p className="truncate" title={label}>
      {label}
    </p>
  );
}

// Ordered on the server (newest first, across pages), so no column sorts.
const columns: ColumnDef<AuditRow>[] = [
  {
    id: "when",
    header: "When",
    meta: { cellClassName: "whitespace-nowrap text-xs text-muted-foreground" },
    cell: ({ row }) => <DateCell value={row.original.time} withTime />,
  },
  {
    id: "who",
    header: "Who",
    meta: { cellClassName: "max-w-[192px]" },
    cell: ({ row }) => <WhoCell actor={row.original.actor} />,
  },
  {
    id: "what",
    header: "What",
    meta: { cellClassName: "max-w-[360px]" },
    cell: ({ row }) => <WhatCell event={row.original} />,
  },
  {
    id: "subject",
    header: "Subject",
    meta: { cellClassName: "max-w-[220px]" },
    cell: ({ row }) => <SubjectCell subject={row.original.subject} />,
  },
];

export function AuditTable({
  events,
  isLoading,
  error,
  toolbar,
  footer,
  isFiltered,
  onClearFilters,
}: AuditTableProps) {
  const table = useDataTable({
    data: events,
    columns,
    getRowId: (event) => event.id,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      toolbar={toolbar}
      footer={footer}
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
      filteredTitle="No audit events match"
      empty={{
        title: "No audit events yet",
        description:
          "What happens in the workspace (members, apps, caps, connections, tokens) shows up here, kept 90 days.",
      }}
    />
  );
}
