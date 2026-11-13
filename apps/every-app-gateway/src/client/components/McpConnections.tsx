import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { BadgeCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  domainCoversRedirect,
  isLoopbackHost,
} from "@/client/components/oauth/clientSite";
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

/** The text `useTableSearch` finds a connection by. */
export function mcpConnectionSearchText(connection: McpConnection) {
  return [
    connection.clientName,
    connection.clientDomain,
    connection.redirectHost,
    connection.organizationName,
    connection.app?.name,
  ];
}

/**
 * Whether the connections are in more than one organization. Most people
 * are in one, and a column that says its name on every row says nothing.
 */
export function spansOrganizations(
  connections: readonly McpConnection[],
): boolean {
  return (
    new Set(connections.map((connection) => connection.organizationName)).size >
    1
  );
}

/**
 * Who vouches for the client's name, and where it sends access: the
 * domain that publishes its details when that covers where access goes; a
 * warning when it doesn't, or when nobody vouches for it and access goes
 * to another site. A client that registered itself and sends access back
 * to the computer it runs on (a CLI, a desktop app) is simply on the
 * person's computer: it can't send access anywhere else, and they approved
 * it there. `local` false leaves that line out, for a list that is only
 * such apps.
 */
function ClientOrigin({
  connection,
  local,
}: {
  connection: McpConnection;
  local: boolean;
}) {
  const { clientDomain: domain, redirectHost: host } = connection;
  if (domain && domainCoversRedirect(domain, host)) {
    return (
      <>
        <BadgeCheck className="size-3 shrink-0 text-success" />
        <span className="truncate">{domain}</span>
      </>
    );
  }
  if (!domain && isLoopbackHost(host)) {
    return local ? <span className="truncate">On your computer</span> : null;
  }
  return (
    <>
      <TriangleAlert className="size-3 shrink-0 text-warning-foreground dark:text-warning" />
      <span className="truncate">
        {domain
          ? `Published on ${domain}, sends access to ${host}`
          : `Unverified · sends access to ${host}`}
      </span>
    </>
  );
}

/** The client's name, and under it who vouches for it (`ClientOrigin`). */
function ClientCell({
  connection,
  local,
}: {
  connection: McpConnection;
  local: boolean;
}) {
  const origin = ClientOrigin({ connection, local });
  return (
    <>
      <p className="truncate font-medium">{connection.clientName}</p>
      {origin ? (
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {origin}
        </p>
      ) : null}
    </>
  );
}

export function clientColumn(
  label: string,
  { local = true }: { local?: boolean } = {},
): ColumnDef<McpConnection> {
  return {
    id: "client",
    accessorFn: (connection) => connection.clientName,
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    meta: { label, cellClassName: "max-w-[360px]" },
    cell: ({ row: { original: connection } }) => (
      <ClientCell connection={connection} local={local} />
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
