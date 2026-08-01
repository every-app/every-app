import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { getServerErrorMessage } from "@/client/errors";
import type { AppWithAccessCount } from "@/types/app";

interface CreateUserTokenModalProps {
  open: boolean;
  onClose: () => void;
  apps: AppWithAccessCount[];
  onCreate: (input: {
    name: string;
    appId?: string;
    expiresAt?: string;
  }) => Promise<void>;
}

function defaultExpiryValue(): string {
  const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function CreateUserTokenModal({
  open,
  onClose,
  apps,
  onCreate,
}: CreateUserTokenModalProps) {
  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => a.name.localeCompare(b.name)),
    [apps],
  );
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [expiresAt, setExpiresAt] = useState(defaultExpiryValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const reset = () => {
    setName("");
    setAppId("");
    setExpiresAt(defaultExpiryValue());
    setError(null);
    setIsPending(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsPending(true);

    try {
      await onCreate({
        name,
        appId: appId || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
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
      title="Create Personal Access Token"
      description="For Claude Code, Cursor, and API clients. claude.ai connectors need the OAuth connector (coming later)."
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-user-token-form"
            className="btn btn-primary"
            disabled={isPending}
          >
            {isPending ? "Creating..." : "Create Token"}
          </button>
        </>
      }
    >
      <form
        id="create-user-token-form"
        className="space-y-4 mt-4"
        onSubmit={handleSubmit}
      >
        <fieldset className="fieldset">
          <legend className="fieldset-legend">Name</legend>
          <input
            className="input w-full"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            placeholder="Claude Code on MacBook"
            required
          />
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">App scope</legend>
          <select
            className="select w-full"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
          >
            <option value="">All my apps</option>
            {sortedApps.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name} ({app.appId})
              </option>
            ))}
          </select>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Expiration</legend>
          <input
            type="datetime-local"
            className="input w-full"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            required
          />
        </fieldset>

        {error && <p className="text-error text-sm">{error}</p>}
      </form>
    </Modal>
  );
}
