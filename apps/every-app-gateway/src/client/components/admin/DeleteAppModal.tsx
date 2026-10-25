import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { isMcpApp, isRemoteMcpApp } from "@/client/lib/appStatus";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import type { AppWithAccessCount } from "@/types/app";

interface DeleteAppModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
  onConfirm: () => void;
  /** While the removal runs: Cancel and Escape do nothing. */
  pending?: boolean;
}

/**
 * Asks before deleting an app. An MCP app is removed (the tombstone
 * `everyapp mcp remove` writes: access, tokens, its tools snapshot and its
 * place in AI connections go, its credential stays), which its dialog
 * says; turning it off, which keeps everything, is the row menu's Turn
 * off. Render it only while it is open.
 */
export function DeleteAppModal({
  app,
  onClose,
  onConfirm,
  pending = false,
}: DeleteAppModalProps) {
  const mcp = isMcpApp(app);
  const people =
    app.accessCount > 0
      ? `${app.accessCount} ${app.accessCount === 1 ? "user" : "users"}`
      : null;
  const copy = MCP_APP_COPY.remove;
  return (
    <ConfirmDialog
      title={mcp ? copy.title(app.name) : `Delete ${app.name}?`}
      confirmLabel={mcp ? copy.confirm : "Delete app"}
      destructive
      pending={pending}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {mcp ? (
        <>
          {copy.body(people)}{" "}
          {isRemoteMcpApp(app) ? (
            copy.againRemote
          ) : (
            <>
              <span className="font-mono text-xs">
                {copy.againBuiltinCommand(app.appId)}
              </span>{" "}
              {copy.againBuiltin}
            </>
          )}
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
