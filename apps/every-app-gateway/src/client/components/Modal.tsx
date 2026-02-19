import type { ReactNode, RefObject, SyntheticEvent, MouseEvent } from "react";
import { useDialogControl } from "@/client/hooks/useDialogControl";

interface BaseModalProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  children: ReactNode;
  boxClassName?: string;
  className?: string;
  showBackdrop?: boolean;
  onCancel?: (event: SyntheticEvent) => void;
  onBackdropClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function BaseModal({
  dialogRef,
  onClose,
  children,
  boxClassName = "",
  className = "",
  showBackdrop = true,
  onCancel,
  onBackdropClick,
}: BaseModalProps) {
  return (
    <dialog
      ref={dialogRef}
      className={`modal modal-bottom sm:modal-middle ${className}`.trim()}
      onClose={onClose}
      onCancel={onCancel}
    >
      <div
        className={`modal-box pt-[calc(env(safe-area-inset-top)+1rem)] sm:pt-6 ${boxClassName}`.trim()}
      >
        {children}
      </div>
      {showBackdrop && (
        <form method="dialog" className="modal-backdrop">
          <button onClick={onBackdropClick}>close</button>
        </form>
      )}
    </dialog>
  );
}

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
  const handleCancel = (e: SyntheticEvent) => {
    if (blocking) {
      e.preventDefault();
    }
  };

  return (
    <BaseModal
      dialogRef={dialogRef}
      onClose={onClose}
      onCancel={handleCancel}
      showBackdrop={!blocking}
    >
      <div className="flex items-center gap-3">
        {icon}
        <h3 className="font-bold text-lg">{title}</h3>
      </div>
      {description && <p>{description}</p>}
      {children}
      <div className="modal-action">{actions}</div>
    </BaseModal>
  );
}
