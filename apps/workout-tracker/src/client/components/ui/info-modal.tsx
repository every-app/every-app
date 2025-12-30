import { Button } from "./button";
import { useDialogControl } from "@/client/hooks/useDialogControl";

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
  const dialogRef = useDialogControl(isOpen);

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
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
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
