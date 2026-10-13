import { CodeBlock } from "@/client/components/CodeBlock";
import { Modal } from "../Modal";

export interface RevealedLink {
  title: string;
  description: string;
  url: string;
  expiresAt: Date | string;
}

interface LinkRevealModalProps {
  link: RevealedLink | null;
  onClose: () => void;
}

/** Show a one-time link (invitation, password reset) for the admin to share. */
export function LinkRevealModal({ link, onClose }: LinkRevealModalProps) {
  if (!link) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={link.title}
      description={link.description}
      actions={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="mt-4 space-y-3">
        <CodeBlock code={link.url} />
        <p className="text-sm text-base-content/60">
          Works once, until {new Date(link.expiresAt).toLocaleString()}. Share
          it privately: anyone with this link can use it.
        </p>
      </div>
    </Modal>
  );
}
