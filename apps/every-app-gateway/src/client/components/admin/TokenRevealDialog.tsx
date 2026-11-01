import { TriangleAlert } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";

/**
 * Shows a newly created token (or a webhook's signing secret) once, with a
 * usage snippet under it. Render it only while open. Only Done closes it:
 * Escape and an outside click do nothing, so the token can't be lost by
 * accident.
 */
export function TokenRevealDialog({
  title,
  description,
  token,
  tokenLabel = "Token",
  warning = "Save this token now. It will not be shown again.",
  copiedMessage = "Token copied",
  usageLabel,
  usage,
  onClose,
}: {
  title: string;
  description: string;
  token: string;
  /** What the value is called above its box. */
  tokenLabel?: string;
  /** The one-time warning. */
  warning?: string;
  /** The toast after a copy. */
  copiedMessage?: string;
  usageLabel: string;
  usage: string;
  onClose: () => void;
}) {
  return (
    <Dialog open disablePointerDismissal>
      <DialogContent
        showCloseButton={false}
        // A minmax(0, 1fr) track, so the long token scrolls in its box and
        // does not push the dialog wider.
        className="grid-cols-1 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Alert variant="warning">
          <TriangleAlert aria-hidden />
          <AlertDescription className="text-foreground">
            {warning}
          </AlertDescription>
        </Alert>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{tokenLabel}</p>
          <CodeBlock code={token} successMessage={copiedMessage} />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{usageLabel}</p>
          <CodeBlock code={usage} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
