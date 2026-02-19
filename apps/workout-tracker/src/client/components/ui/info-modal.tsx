import { Button } from "./button";
import { useDialogControl } from "@/client/hooks/useDialogControl";
import { Modal } from "./modal";

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
    <Modal dialogRef={dialogRef} onClose={onClose}>
      <h3 className="font-bold text-lg">{title}</h3>
      <p className="py-4 text-base-content/70 whitespace-pre-line">
        {description}
      </p>
      <div className="modal-action">
        <Button variant="primary" onClick={onClose}>
          {buttonText}
        </Button>
      </div>
    </Modal>
  );
}
