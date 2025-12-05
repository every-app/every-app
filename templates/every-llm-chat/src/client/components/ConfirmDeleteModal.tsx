import { useEffect, useRef } from "react";

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  chatTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteModal({
  isOpen,
  chatTitle,
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps) {
  const modalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    if (isOpen) {
      modal.showModal();
    } else {
      modal.close();
    }
  }, [isOpen]);

  const handleConfirm = () => {
    onConfirm();
    modalRef.current?.close();
  };

  const handleCancel = () => {
    onCancel();
    modalRef.current?.close();
  };

  return (
    <dialog ref={modalRef} className="modal" onClose={onCancel}>
      <div className="modal-box">
        <h3 className="font-bold text-lg">Delete Chat</h3>
        <p className="py-4">
          Are you sure you want to permanently delete "{chatTitle}" and all its
          messages? This action cannot be undone.
        </p>
        <div className="modal-action">
          <button onClick={handleCancel} className="btn btn-ghost">
            Cancel
          </button>
          <button onClick={handleConfirm} className="btn btn-error">
            Delete
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={handleCancel}>close</button>
      </form>
    </dialog>
  );
}
