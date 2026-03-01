import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import type { AppWithAccessCount } from "@/types/app";
import { getServerErrorMessage } from "@/client/errors";

interface CreateAppTokenModalProps {
  open: boolean;
  onClose: () => void;
  apps: AppWithAccessCount[];
  onCreate: (input: {
    appId: string;
    scopes: string[];
    expiresAt: string | null;
  }) => Promise<void>;
}

export function CreateAppTokenModal({
  open,
  onClose,
  apps,
  onCreate,
}: CreateAppTokenModalProps) {
  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => a.name.localeCompare(b.name)),
    [apps],
  );
  const defaultAppId = sortedApps[0]?.id ?? "";

  const [appId, setAppId] = useState("");
  const [scopes, setScopes] = useState("provider:openai");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const reset = () => {
    setAppId("");
    setScopes("provider:openai");
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

    const selectedAppId = appId || defaultAppId;
    if (!selectedAppId) {
      setError("Please select an app");
      return;
    }

    const parsedScopes = scopes
      .split(",")
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);

    if (parsedScopes.length === 0) {
      setError("At least one scope is required");
      return;
    }

    setIsPending(true);
    try {
      await onCreate({
        appId: selectedAppId,
        scopes: parsedScopes,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
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
      title="Create App Token"
      description="Generate a machine token for gateway provider access."
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-app-token-form"
            className="btn btn-primary"
            disabled={isPending || sortedApps.length === 0}
          >
            {isPending ? "Creating..." : "Create Token"}
          </button>
        </>
      }
    >
      <form
        id="create-app-token-form"
        className="space-y-4 mt-4"
        onSubmit={handleSubmit}
      >
        <fieldset className="fieldset">
          <legend className="fieldset-legend">App</legend>
          <select
            className="select w-full"
            value={appId || defaultAppId}
            onChange={(e) => setAppId(e.target.value)}
            disabled={sortedApps.length === 0}
          >
            {sortedApps.length === 0 ? (
              <option value="">No apps available</option>
            ) : (
              sortedApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} ({app.appId})
                </option>
              ))
            )}
          </select>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Scopes (comma-separated)</legend>
          <input
            className="input w-full"
            placeholder="provider:openai"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
          <p className="label text-base-content/60">
            Example: provider:openai, provider:anthropic
          </p>
        </fieldset>

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
