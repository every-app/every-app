import { Modal } from "./Modal";

interface SafariDevModeWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SafariDevModeWarningModal({
  open,
  onOpenChange,
}: SafariDevModeWarningModalProps) {
  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Local dev may not work in Safari"
      actions={
        <button type="button" className="btn btn-primary" onClick={handleClose}>
          Got It
        </button>
      }
    >
      <div className="mt-4 space-y-3">
        <p className="font-medium">
          Switch to Chrome or other Chromium browsers for local development.
        </p>
        <p>
          Safari blocks local development servers (http://) from loading within
          "https://" pages. Your app may not display correctly.
        </p>
      </div>
    </Modal>
  );
}
