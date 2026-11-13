import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { getRuleErrorMessage } from "@/client/errors";
import {
  disconnectConnection,
  removeConnectionApp,
} from "@/serverFunctions/connections";

/** A connection as Your connections → Accounts and Manage workspace → Providers list it. */
interface Removable {
  id: string;
  providerName: string;
  apps: { rowId: string; name: string }[];
}

/** One app's access to one connection, as the removal names it. */
export interface AppAccess<C extends Removable> {
  connection: C;
  app: C["apps"][number];
}

/**
 * Disconnect, and taking one app's access away, each behind its confirm
 * dialog: for the person's own connections (`person` null), or for anyone's
 * on the Providers tab (`person` names whose). `onChanged` refreshes the
 * lists. Render `dialogs` once in the page.
 */
export function useConnectionRemoval<C extends Removable>({
  person,
  name = (connection) => connection.providerName,
  onChanged,
}: {
  person: ((connection: C) => string) | null;
  /** How the dialogs name a connection, when the list names it by more than its provider. */
  name?: (connection: C) => string;
  onChanged: () => Promise<unknown>;
}) {
  const [disconnecting, setDisconnecting] = useState<C | null>(null);
  const [removingApp, setRemovingApp] = useState<AppAccess<C> | null>(null);
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      await onChanged();
      toast.success("Disconnected");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to disconnect")),
  });
  const removeAppMutation = useMutation({
    mutationFn: removeConnectionApp,
    onSuccess: async () => {
      await onChanged();
      toast.success("Access removed");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to remove access")),
  });
  const whose = (connection: C) =>
    person ? `${person(connection)}'s ${name(connection)}` : name(connection);
  const account = person ? "this person's account" : "this account";

  const dialogs = (
    <>
      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${whose(disconnecting)}?`}
          confirmLabel="Disconnect"
          destructive
          pending={disconnectMutation.isPending}
          onClose={() => setDisconnecting(null)}
          onConfirm={() =>
            disconnectMutation.mutate(
              { data: { connectionId: disconnecting.id } },
              { onSettled: () => setDisconnecting(null) },
            )
          }
        >
          Every app stops using {account} at once.
        </ConfirmDialog>
      ) : null}

      {removingApp ? (
        <ConfirmDialog
          title={`Remove ${removingApp.app.name}'s access to ${whose(removingApp.connection)}?`}
          confirmLabel="Remove access"
          destructive
          pending={removeAppMutation.isPending}
          onClose={() => setRemovingApp(null)}
          onConfirm={() =>
            removeAppMutation.mutate(
              {
                data: {
                  connectionId: removingApp.connection.id,
                  appRowId: removingApp.app.rowId,
                },
              },
              { onSettled: () => setRemovingApp(null) },
            )
          }
        >
          {removingApp.app.name} stops using {account} until{" "}
          {person ? "they" : "you"} allow it again there.
        </ConfirmDialog>
      ) : null}
    </>
  );
  return {
    askDisconnect: setDisconnecting,
    askRemoveApp: setRemovingApp,
    dialogs,
  };
}
