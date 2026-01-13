import { Modal } from "./Modal";

interface SafariDevModeWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function WarningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 text-yellow-500 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
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
      title="Local dev doesn't work in Safari"
      icon={<WarningIcon />}
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
          "https://" pages.
        </p>
      </div>
    </Modal>
  );
}
