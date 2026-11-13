import { TokenRevealDialog } from "./TokenRevealDialog";

/** The new personal access token, shown once. Render it only while open. */
export function UserTokenRevealModal({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  return (
    <TokenRevealDialog
      title="New personal access token"
      token={token}
      usageLabel="Authorization header"
      usage={`Authorization: Bearer ${token}`}
      onClose={onClose}
    />
  );
}
