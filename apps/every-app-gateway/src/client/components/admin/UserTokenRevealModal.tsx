import { CodeBlock } from "@/client/components/CodeBlock";
import { Modal } from "../Modal";

interface UserTokenRevealModalProps {
  open: boolean;
  onClose: () => void;
  token: string | null;
}

export function UserTokenRevealModal({
  open,
  onClose,
  token,
}: UserTokenRevealModalProps) {
  if (!open || !token) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Personal Access Token"
      description="Save this token now. It will not be shown again."
      blocking
      actions={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="mt-4 space-y-4">
        <div>
          <p className="text-sm font-medium mb-1">Token</p>
          <CodeBlock code={token} />
        </div>
        <div>
          <p className="text-sm font-medium mb-1">Authorization header</p>
          <CodeBlock code={`Authorization: Bearer ${token}`} />
        </div>
      </div>
    </Modal>
  );
}
