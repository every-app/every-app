import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Modal } from "../Modal";

interface LinkDisplayModalProps {
  open: boolean;
  onClose: () => void;
  link: string | null;
  type: "invite" | "reset";
}

export function LinkDisplayModal({
  open,
  onClose,
  link,
  type,
}: LinkDisplayModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (link) {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!open || !link) return null;

  const title =
    type === "invite" ? "Invitation Link Created" : "Password Reset Link";
  const description =
    type === "invite"
      ? "Send this link to the user via email or text message. They will use it to set their password and activate their account."
      : "Send this link to the user via email or text message. They will use it to reset their password.";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="text-base-content/70 mt-2 text-sm">{description}</p>
      <div className="mt-4">
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={link}
            className="input input-bordered w-full text-sm font-mono"
          />
          <button
            className="btn btn-primary btn-square"
            onClick={handleCopy}
            title="Copy to clipboard"
          >
            {copied ? (
              <Check className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
        {copied && (
          <div className="alert alert-success mt-3">
            <Check className="w-4 h-4" />
            <span>Copied to clipboard!</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
