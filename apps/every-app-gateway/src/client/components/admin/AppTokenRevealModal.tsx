import { CodeBlock } from "@/client/components/CodeBlock";
import { Modal } from "../Modal";

interface AppTokenRevealModalProps {
  open: boolean;
  onClose: () => void;
  token: string | null;
}

export function AppTokenRevealModal({
  open,
  onClose,
  token,
}: AppTokenRevealModalProps) {
  if (!open || !token) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Deploy Token"
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
          <p className="text-sm font-medium mb-1">Use with the CLI</p>
          <CodeBlock code="everyapp login" />
        </div>
      </div>
    </Modal>
  );
}
