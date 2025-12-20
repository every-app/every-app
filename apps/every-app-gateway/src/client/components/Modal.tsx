import { useCloseModalOnEscape } from "@/client/hooks/useCloseModalOnEscape";
import type { ReactNode } from "react";

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
 * Handles escape key closing and backdrop click.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
}: ModalProps) {
  useCloseModalOnEscape(open, onClose);

  return (
    <dialog className={`modal ${open ? "modal-open" : ""}`}>
      <div className="modal-box">
        <h3 className="font-bold text-lg">{title}</h3>
        {description && <p>{description}</p>}
        {children}
        <div className="modal-action">{actions}</div>
      </div>
      <form method="dialog" className="modal-backdrop" onClick={onClose}>
        <button type="button">close</button>
      </form>
    </dialog>
  );
}
