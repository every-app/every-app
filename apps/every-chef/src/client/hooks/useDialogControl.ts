import { useEffect, useRef } from "react";

/**
 * Hook to control a native HTML dialog element using the showModal() API.
 * This uses the browser's "top layer" for proper stacking context.
 *
 * @param isOpen - Whether the dialog should be open
 * @returns A ref to attach to the dialog element
 */
export function useDialogControl(isOpen: boolean) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  return dialogRef;
}
