import { COMPOSIO_IS, COMPOSIO_NOTICE } from "@every-app/sdk/internal";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";

/**
 * Asks before Composio is turned on for the organization
 * (docs/design/2026-11-composio.md): what it is, and that requests to the
 * accounts people use from it pass through it. Every way of turning it on
 * shows this first. Render it only while it is open.
 */
export function TurnOnComposioDialog({
  confirmLabel = "Turn on",
  pending = false,
  onConfirm,
  onClose,
}: {
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title="Turn on Composio?"
      confirmLabel={confirmLabel}
      pending={pending}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {COMPOSIO_IS} With it on, providers need no OAuth app here.{" "}
      {COMPOSIO_NOTICE}
    </ConfirmDialog>
  );
}
