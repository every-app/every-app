import { Modal } from "../Modal";

interface DeleteUserModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  userName: string | null;
  userEmail: string;
}

export function DeleteUserModal({
  open,
  onClose,
  onConfirm,
  userName,
  userEmail,
}: DeleteUserModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete User"
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-error" onClick={onConfirm}>
            Delete
          </button>
        </>
      }
    >
      <p className="py-4">
        Are you sure you want to delete <strong>{userName || userEmail}</strong>
        ? This action cannot be undone.
      </p>
    </Modal>
  );
}
