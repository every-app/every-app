import { CodeBlock } from "@/client/components/CodeBlock";
import { Modal } from "../Modal";

interface AppTokenRevealModalProps {
  open: boolean;
  onClose: () => void;
  appName: string;
  token: string | null;
}

export function AppTokenRevealModal({
  open,
  onClose,
  appName,
  token,
}: AppTokenRevealModalProps) {
  if (!open || !token) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New App Token"
      description={`Save this token now for ${appName}. It will not be shown again.`}
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
          <p className="text-sm font-medium mb-1">
            Add to your app&apos;s <code className="text-xs">.env.local</code>
          </p>
          <CodeBlock code={`GATEWAY_APP_API_TOKEN=${token}`} />
        </div>
      </div>
    </Modal>
  );
}
