import { useState } from "react";
import { Modal } from "../Modal";
import { getServerErrorMessage } from "@/client/errors";

interface CreateAppTokenModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: {
    tokenType: "deploy";
    expiresAt: string | null;
  }) => Promise<void>;
}

export function CreateAppTokenModal({
  open,
  onClose,
  onCreate,
}: CreateAppTokenModalProps) {
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const reset = () => {
    setExpiresAt("");
    setError(null);
    setIsPending(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    setIsPending(true);
    try {
      const parsedExpiresAt = expiresAt
        ? new Date(expiresAt).toISOString()
        : null;
      await onCreate({
        tokenType: "deploy",
        expiresAt: parsedExpiresAt,
      });
      handleClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to create token"));
      setIsPending(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create Deploy Token"
      description="Generate an organization-scoped token for CLI deploys."
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-app-token-form"
            className="btn btn-primary"
            disabled={isPending}
          >
            {isPending ? "Creating..." : "Create Deploy Token"}
          </button>
        </>
      }
    >
      <form
        id="create-app-token-form"
        className="space-y-4 mt-4"
        onSubmit={handleSubmit}
      >
        <div className="rounded-box border border-base-300 bg-base-200/50 p-4">
          <p className="text-sm text-base-content/70">
            Deploy tokens are scoped to this organization and can register apps
            during <code className="text-xs">everyapp deploy</code>.
          </p>
        </div>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Expiration (optional)</legend>
          <input
            type="datetime-local"
            className="input w-full"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </fieldset>

        {error && <p className="text-error text-sm">{error}</p>}
      </form>
    </Modal>
  );
}
