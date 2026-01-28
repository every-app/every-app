import { Modal } from "../Modal";
import { AlertTriangle } from "lucide-react";
import type { AppWithAccessCount } from "@/types/app";

interface DeleteAppModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  app: AppWithAccessCount | null;
}

export function DeleteAppModal({
  open,
  onClose,
  onConfirm,
  app,
}: DeleteAppModalProps) {
  if (!open || !app) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete App"
      icon={<AlertTriangle className="w-6 h-6 text-error" />}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-error" onClick={onConfirm}>
            Delete App
          </button>
        </>
      }
    >
      <div className="py-4">
        <p>
          Are you sure you want to delete <strong>{app.name}</strong>?
        </p>
        {app.accessCount > 0 && (
          <p className="text-warning mt-2">
            This will revoke access from {app.accessCount}{" "}
            {app.accessCount === 1 ? "user" : "users"}.
          </p>
        )}
        <p className="text-base-content/70 mt-2 text-sm">
          This action cannot be undone.
        </p>
      </div>
    </Modal>
  );
}
