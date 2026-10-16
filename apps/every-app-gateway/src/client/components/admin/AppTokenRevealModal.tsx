import { TokenRevealDialog } from "./TokenRevealDialog";

/** The new deploy token, shown once. Render it only while open. */
export function AppTokenRevealModal({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  return (
    <TokenRevealDialog
      title="New deploy token"
      description="Paste it when the CLI asks for a token. It can register and deploy apps in this organization."
      token={token}
      usageLabel="Use with the CLI"
      usage="everyapp login"
      onClose={onClose}
    />
  );
}
