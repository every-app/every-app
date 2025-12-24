import { Button } from "./button";
import { useModal } from "@/client/hooks/useModal";

interface InfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  buttonText?: string;
}

export function InfoModal({
  isOpen,
  onClose,
  title,
  description,
  buttonText = "Got it",
}: InfoModalProps) {
  const { dialogRef, handleBackdropClick } = useModal(isOpen, onClose);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onClick={handleBackdropClick}
      onClose={onClose}
    >
      <div className="modal-box">
        <h3 className="font-bold text-lg">{title}</h3>
        <p className="py-4 text-base-content/70 whitespace-pre-line">
          {description}
        </p>
        <div className="modal-action">
          <Button variant="primary" onClick={onClose}>
            {buttonText}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
