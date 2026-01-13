import type { ReactNode } from "react";
import { useDialogControl } from "@/client/hooks/useDialogControl";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  actions: ReactNode;
  /** When true, prevents dismissing via backdrop click or ESC key */
  blocking?: boolean;
  /** Optional icon to display inline with the title */
  icon?: ReactNode;
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
  blocking = false,
  icon,
}: ModalProps) {
  const dialogRef = useDialogControl(open);

  // Prevent ESC key from closing blocking modals
  const handleCancel = (e: React.SyntheticEvent) => {
    if (blocking) {
      e.preventDefault();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
      onCancel={handleCancel}
    >
      <div className="modal-box">
        <div className="flex items-center gap-3">
          {icon}
          <h3 className="font-bold text-lg">{title}</h3>
        </div>
        {description && <p>{description}</p>}
        {children}
        <div className="modal-action">{actions}</div>
      </div>
      {!blocking && (
        <form method="dialog" className="modal-backdrop">
          <button>close</button>
        </form>
      )}
    </dialog>
  );
}
