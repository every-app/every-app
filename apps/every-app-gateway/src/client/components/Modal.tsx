import type { ReactNode } from "react";
import { useDialogControl } from "@/client/hooks/useDialogControl";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  actions: ReactNode;
}

/**
 * Reusable modal component with consistent styling and behavior.
 * Uses native dialog showModal() API for proper top-layer rendering.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
}: ModalProps) {
  const dialogRef = useDialogControl(open);

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
    >
      <div className="modal-box">
        <h3 className="font-bold text-lg">{title}</h3>
        {description && <p>{description}</p>}
        {children}
        <div className="modal-action">{actions}</div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
