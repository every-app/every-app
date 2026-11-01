import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/client/components/ui/alert-dialog";
import { Button } from "@/client/components/ui/button";

/**
 * Asks before an action that cannot be undone: a delete, or one that spends
 * credits. Render it only while it is open. `onConfirm` does not close it, so
 * the caller closes it right away or when the mutation settles. While
 * `pending`, Cancel and Escape do nothing.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onClose,
  pending = false,
  destructive = false,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** Rename Cancel when the action itself is a cancel, e.g. "Keep invitation". */
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost" disabled={pending}>
            {cancelLabel}
          </AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            pending={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
