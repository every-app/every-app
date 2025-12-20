import { userAppsCollection } from "@/client/tanstack-db";
import type { UserApp } from "@/types/user-app";
import { Modal } from "./Modal";

interface DeleteAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: UserApp | null;
}

export function DeleteAppModal({
  open,
  onOpenChange,
  app,
}: DeleteAppModalProps) {
  const handleDelete = () => {
    if (!app) return;
    userAppsCollection.delete(app.id);
    onOpenChange(false);
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Delete App"
      actions={
        <>
          <button
            type="button"
            className="btn btn-outline"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-error"
            onClick={handleDelete}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="mt-4">
        Are you sure you want to delete{" "}
        <span className="font-semibold">{app?.name}</span>? This action cannot
        be undone.
      </p>
    </Modal>
  );
}
