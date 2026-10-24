import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { isMcpApp } from "@/client/lib/appStatus";
import type { AppWithAccessCount } from "@/types/app";

interface DeleteAppModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Asks before deleting an app. An MCP app is turned off rather than
 * deleted (the same tombstone `everyapp mcp off` writes; `mcp on` brings it
 * back), so its dialog says that. Render it only while it is open.
 */
export function DeleteAppModal({
  app,
  onClose,
  onConfirm,
}: DeleteAppModalProps) {
  const mcp = isMcpApp(app);
  const people =
    app.accessCount > 0
      ? `${app.accessCount} ${app.accessCount === 1 ? "user" : "users"}`
      : null;
  return (
    <ConfirmDialog
      title={mcp ? `Turn off ${app.name}?` : `Delete ${app.name}?`}
      confirmLabel={mcp ? "Turn off" : "Delete app"}
      destructive
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {mcp ? (
        <>
          Its tools leave this Gateway's MCP address
          {people ? `, ${people} lose access to it` : ""}, and tokens for it
          stop working.{" "}
          <span className="font-mono text-xs">
            pnpm everyapp mcp on {app.appId}
          </span>{" "}
          turns it on again, for owners and admins first.
        </>
      ) : (
        <>
          {people ? `This will revoke access from ${people}. ` : null}
          This action cannot be undone.
        </>
      )}
    </ConfirmDialog>
  );
}
