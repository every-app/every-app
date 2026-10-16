import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import type { AppWithAccessCount } from "@/types/app";

interface DeleteAppModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
  onConfirm: () => void;
}

/** Asks before deleting an app. Render it only while it is open. */
export function DeleteAppModal({
  app,
  onClose,
  onConfirm,
}: DeleteAppModalProps) {
  return (
    <ConfirmDialog
      title={`Delete ${app.name}?`}
      confirmLabel="Delete app"
      destructive
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {app.accessCount > 0
        ? `This will revoke access from ${app.accessCount} ${
            app.accessCount === 1 ? "user" : "users"
          }. `
        : null}
      This action cannot be undone.
    </ConfirmDialog>
  );
}
