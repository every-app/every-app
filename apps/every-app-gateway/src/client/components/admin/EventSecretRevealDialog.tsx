import { TokenRevealDialog } from "./TokenRevealDialog";

/**
 * The signing secret the Gateway generated for a new webhook subscription,
 * shown once, like a new personal access token (UserTokenRevealModal): no
 * list, no edit and no other surface shows it again. The receiver checks
 * each delivery's signature header with it. Render it only while open.
 */
export function EventSecretRevealDialog({
  name,
  secret,
  onClose,
}: {
  /** The subscription's name, for the title. */
  name: string;
  secret: string;
  onClose: () => void;
}) {
  return (
    <TokenRevealDialog
      title={`Signing secret for ${name}`}
      description="Every delivery is signed with it, so the receiver can tell it came from this Gateway. Store it where the receiver reads its settings."
      token={secret}
      tokenLabel="Signing secret"
      warning="Copy it now; it isn't shown again."
      copiedMessage="Signing secret copied"
      usageLabel="Each delivery carries"
      usage={`X-EveryApp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`}
      onClose={onClose}
    />
  );
}
