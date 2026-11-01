import { ConfirmDialog } from "@/client/components/ConfirmDialog";

interface DeleteUserModalProps {
  onClose: () => void;
  onConfirm: () => void;
  userName: string | null;
  userEmail: string;
}

/** Confirms deleting a user. Render it only while it is open. */
export function DeleteUserModal({
  onClose,
  onConfirm,
  userName,
  userEmail,
}: DeleteUserModalProps) {
  return (
    <ConfirmDialog
      title={`Delete ${userName || userEmail}?`}
      confirmLabel="Delete user"
      destructive
      onClose={onClose}
      onConfirm={onConfirm}
    >
      Removes them from this organization and revokes their tokens. This can't
      be undone.
    </ConfirmDialog>
  );
}
