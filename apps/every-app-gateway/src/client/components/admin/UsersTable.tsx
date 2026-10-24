import { createContext, useContext, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import type { AdminUser } from "@/types/admin-user";
import { UserActionsMenu, type UserActions } from "./UserActionsMenu";

interface UserRowOptions extends UserActions {
  emailConfigured: boolean;
  canManageInvitations: boolean;
  isOwner: boolean;
  currentUserId: string | undefined;
}

interface UsersTableProps extends UserRowOptions {
  users: AdminUser[];
  /** The first load: skeleton rows under the headers. */
  isLoading: boolean;
  /** A load failure, shown above the rows (or in their place). */
  error?: ReactNode;
}

// The cells read the page's callbacks from context. The columns stay one
// module-level array: TanStack Table renders each `cell` function as a
// component, so columns rebuilt on every render would remount every cell and
// close an open row menu or confirmation.
const UserRowContext = createContext<UserRowOptions | null>(null);

function useUserRowContext() {
  const context = useContext(UserRowContext);
  if (!context) throw new Error("UsersTable cells need a UserRowContext");
  return context;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function formatRole(role: string) {
  return role
    .split(",")
    .map((name) => ROLE_LABELS[name.trim()] ?? name.trim())
    .join(", ");
}

function UserCell({ user }: { user: AdminUser }) {
  const { currentUserId } = useUserRowContext();
  // An invitation is an email address, not a person with a name yet.
  const name = user.status === "pending" ? user.email : user.name || user.email;
  return (
    <>
      <p className="truncate font-medium">
        {name}
        {user.id === currentUserId ? (
          <span className="font-normal text-muted-foreground"> (you)</span>
        ) : null}
      </p>
      {name !== user.email ? (
        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
      ) : null}
    </>
  );
}

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  pending: "Pending",
};

/** The usual state is plain text; only an exception is a chip. */
function StatusCell({ user }: { user: AdminUser }) {
  if (user.banned) return <Badge variant="destructive">Deactivated</Badge>;
  const status = user.status || "active";
  if (status === "active") {
    return <span className="text-muted-foreground">Active</span>;
  }
  return <Badge variant="warning">{STATUS_LABELS[status] ?? status}</Badge>;
}

function ActionsCell({ user }: { user: AdminUser }) {
  const context = useUserRowContext();
  return <UserActionsMenu user={user} {...context} />;
}

const columns: ColumnDef<AdminUser>[] = [
  {
    id: "user",
    accessorFn: (user) => user.name || user.email,
    header: ({ column }) => <SortableHeader column={column} label="User" />,
    meta: { cellClassName: "max-w-[280px]" },
    cell: ({ row }) => <UserCell user={row.original} />,
  },
  {
    id: "role",
    header: "Role",
    cell: ({ row }) => formatRole(row.original.role || "member"),
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => <StatusCell user={row.original} />,
  },
  {
    id: "createdAt",
    accessorFn: (user) => dateSortValue(user.createdAt, 0),
    header: ({ column }) => <SortableHeader column={column} label="Created" />,
    meta: { cellClassName: "text-xs text-muted-foreground" },
    cell: ({ row }) => <DateCell value={row.original.createdAt} />,
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { headerClassName: "w-10" },
    cell: ({ row }) => <ActionsCell user={row.original} />,
  },
];

export function UsersTable({
  users,
  isLoading,
  error,
  ...context
}: UsersTableProps) {
  const table = useDataTable({
    data: users,
    columns,
    getRowId: (user) => user.id,
    withSorting: true,
    // Newest first from the start, so the row an invitation adds lands at
    // the top, where a fresh load puts it.
    initialState: { sorting: [{ id: "createdAt", desc: true }] },
  });

  return (
    <UserRowContext.Provider value={context}>
      <DataTable
        table={table}
        isLoading={isLoading}
        error={error}
        empty={{ title: "No users yet" }}
      />
    </UserRowContext.Provider>
  );
}
