import { createContext, useContext, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import type { AdminGroup } from "@/types/group";
import { CountCell } from "./CountCell";
import { GroupActionsMenu } from "./GroupActionsMenu";

type GroupActions = {
  onManageMembers: (group: AdminGroup) => void;
  onManageApps: (group: AdminGroup) => void;
  onEdit: (group: AdminGroup) => void;
  onDelete: (group: AdminGroup) => void;
};

interface GroupsTableProps extends GroupActions {
  groups: AdminGroup[];
  isLoading: boolean;
  error?: ReactNode;
  /** The "New group" button for the empty state. */
  createAction?: ReactNode;
}

// The cells read the page's callbacks from context, so the columns stay one
// module-level array (see UsersTable).
const GroupRowContext = createContext<GroupActions | null>(null);

function useGroupActions() {
  const context = useContext(GroupRowContext);
  if (!context) throw new Error("GroupsTable cells need a GroupRowContext");
  return context;
}

function MembersCell({ group }: { group: AdminGroup }) {
  const { onManageMembers } = useGroupActions();
  return (
    <CountCell
      count={group.memberCount}
      noun="member"
      aria-label={`Manage members of ${group.name}`}
      onClick={() => onManageMembers(group)}
    />
  );
}

function AppsCell({ group }: { group: AdminGroup }) {
  const { onManageApps } = useGroupActions();
  return (
    <CountCell
      count={group.appCount}
      noun="app"
      aria-label={`Manage apps for ${group.name}`}
      onClick={() => onManageApps(group)}
    />
  );
}

function ActionsCell({ group }: { group: AdminGroup }) {
  const actions = useGroupActions();
  return (
    <GroupActionsMenu
      groupName={group.name}
      onManageMembers={() => actions.onManageMembers(group)}
      onManageApps={() => actions.onManageApps(group)}
      onEdit={() => actions.onEdit(group)}
      onDelete={() => actions.onDelete(group)}
    />
  );
}

const columns: ColumnDef<AdminGroup>[] = [
  {
    id: "group",
    accessorFn: (group) => group.name,
    header: ({ column }) => <SortableHeader column={column} label="Group" />,
    meta: { label: "Group", cellClassName: "max-w-[320px]" },
    cell: ({ row }) => (
      <>
        <p className="truncate font-medium">{row.original.name}</p>
        {row.original.description ? (
          <p className="truncate text-xs text-muted-foreground">
            {row.original.description}
          </p>
        ) : null}
      </>
    ),
  },
  {
    accessorKey: "memberCount",
    header: ({ column }) => <SortableHeader column={column} label="Members" />,
    meta: { label: "Members" },
    cell: ({ row }) => <MembersCell group={row.original} />,
  },
  {
    accessorKey: "appCount",
    header: ({ column }) => <SortableHeader column={column} label="Apps" />,
    meta: { label: "Apps" },
    cell: ({ row }) => <AppsCell group={row.original} />,
  },
  {
    id: "createdAt",
    accessorFn: (group) => dateSortValue(group.createdAt, 0),
    header: ({ column }) => <SortableHeader column={column} label="Created" />,
    meta: { label: "Created", cellClassName: "text-xs text-muted-foreground" },
    cell: ({ row }) => <DateCell value={row.original.createdAt} />,
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    enableSorting: false,
    meta: { headerClassName: "w-10" },
    cell: ({ row }) => <ActionsCell group={row.original} />,
  },
];

export function GroupsTable({
  groups,
  isLoading,
  error,
  createAction,
  ...actions
}: GroupsTableProps) {
  const table = useDataTable({
    data: groups,
    columns,
    getRowId: (group) => group.id,
    withSorting: true,
  });

  return (
    <GroupRowContext.Provider value={actions}>
      <DataTable
        table={table}
        isLoading={isLoading}
        error={error}
        empty={{
          title: "No groups yet",
          description:
            "Grant apps to a group and everyone in it can open them.",
          action: createAction,
        }}
      />
    </GroupRowContext.Provider>
  );
}
