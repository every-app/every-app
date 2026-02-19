import type { ReactNode, RefObject, SyntheticEvent } from "react";

interface ModalProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  children: ReactNode;
  boxClassName?: string;
  className?: string;
  showBackdrop?: boolean;
  onCancel?: (event: SyntheticEvent) => void;
}

export function Modal({
  dialogRef,
  onClose,
  children,
  boxClassName = "",
  className = "",
  showBackdrop = true,
  onCancel,
}: ModalProps) {
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
          <button>close</button>
        </form>
      )}
    </dialog>
  );
}
