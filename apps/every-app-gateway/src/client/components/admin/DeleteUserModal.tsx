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
      Their deploy tokens and personal access tokens for this organization stop
      working. This action cannot be undone.
      <span className="mt-2 block">
        If Cloudflare Access would let them straight back in (their email domain
        joins automatically), they are deactivated instead, which keeps them
        out.
      </span>
    </ConfirmDialog>
  );
}
