import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { BadgeCheck } from "lucide-react";
import { toast } from "sonner";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { domainCoversRedirect } from "@/client/components/oauth/clientSite";
import {
  DATE_CELL,
  DateCell,
  dateSortValue,
} from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import {
  listMyMcpConnections,
  revokeMyMcpConnection,
} from "@/serverFunctions/mcpConnections";

// What Your connections' Agents and Accounts tabs share about the signed-in
// person's own grants on the Gateway: the AI apps on /mcp (Agents) and the
// native apps signed in on a device (Accounts → Apps on your devices). Only
// the person's own connections are listed, and only they can revoke them.
// Revoking stops the app on its next request.

const MCP_CONNECTIONS_KEY = ["connections", "mcp"];

export type McpConnection = Awaited<
  ReturnType<typeof listMyMcpConnections>
>["connections"][number];

/** A native app or a linked `everyapp dev` project, not an AI app. */
export function isNative(connection: McpConnection): boolean {
  return connection.kind === "native" || connection.kind === "dev";
}

export function useMcpConnections() {
  return useQuery({
    queryKey: MCP_CONNECTIONS_KEY,
    queryFn: () => listMyMcpConnections(),
  });
}

export function useRevokeMcpConnection(successMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeMyMcpConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_KEY });
      toast.success(successMessage);
    },
    onError: () => {
      toast.error("Failed to revoke the connection");
    },
  });
}

/** The client's name, and its verified domain or where it sends access. */
function ClientCell({ connection }: { connection: McpConnection }) {
  return (
    <>
      <p className="truncate font-medium">{connection.clientName}</p>
      <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {connection.clientDomain &&
        domainCoversRedirect(
          connection.clientDomain,
          connection.redirectHost,
        ) ? (
          <>
            <BadgeCheck className="size-3 shrink-0 text-success" />
            <span className="truncate">{connection.clientDomain}</span>
          </>
        ) : (
          <span className="truncate">
            {connection.clientDomain ?? "Unverified"} · sends to{" "}
            {connection.redirectHost}
          </span>
        )}
      </p>
    </>
  );
}

export function clientColumn(label: string): ColumnDef<McpConnection> {
  return {
    id: "client",
    accessorFn: (connection) => connection.clientName,
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    meta: { label, cellClassName: "max-w-[280px]" },
    cell: ({ row: { original: connection } }) => (
      <ClientCell connection={connection} />
    ),
  };
}

export function createdAtColumn(label: string): ColumnDef<McpConnection> {
  return {
    accessorKey: "createdAt",
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    meta: { label, cellClassName: DATE_CELL },
    cell: ({ row: { original: connection } }) => (
      <DateCell value={connection.createdAt} />
    ),
  };
}

export const lastUsedColumn: ColumnDef<McpConnection> = {
  id: "lastUsedAt",
  // Never used sorts as the oldest.
  accessorFn: (connection) => dateSortValue(connection.lastUsedAt, 0),
  header: ({ column }) => <SortableHeader column={column} label="Last used" />,
  meta: { label: "Last used", cellClassName: DATE_CELL },
  cell: ({ row: { original: connection } }) => (
    <DateCell value={connection.lastUsedAt} />
  ),
};

export const organizationColumn: ColumnDef<McpConnection> = {
  accessorKey: "organizationName",
  header: ({ column }) => (
    <SortableHeader column={column} label="Organization" />
  ),
  meta: { label: "Organization" },
};

/** The row's menu, with its one way to revoke the connection. */
export function revokeColumn({
  icon,
  label,
  onRevoke,
  isRevoking,
}: {
  icon: ReactNode;
  label: string;
  onRevoke: (connection: McpConnection) => void;
  isRevoking: boolean;
}): ColumnDef<McpConnection> {
  return {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    enableSorting: false,
    meta: { headerClassName: "w-10" },
    cell: ({ row: { original: connection } }) => (
      <RowActionsMenu label={`Actions for ${connection.clientName}`}>
        <DropdownMenuItem
          variant="destructive"
          disabled={isRevoking}
          onClick={() => onRevoke(connection)}
        >
          {icon}
          {label}
        </DropdownMenuItem>
      </RowActionsMenu>
    ),
  };
}
