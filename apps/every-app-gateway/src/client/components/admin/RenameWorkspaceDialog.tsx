import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { MAX_ORGANIZATION_NAME_LENGTH } from "@every-app/sdk/internal";
import { CircleAlert } from "lucide-react";
import { useAppForm } from "@/client/components/form/useAppForm";
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
import { getServerErrorMessage } from "@/client/errors";
import {
  workspaceNameFormSchema,
  type WorkspaceNameFormData,
} from "@/schemas/organization";

interface RenameWorkspaceDialogProps {
  /** The workspace's name now. */
  name: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Renames the workspace (the organization). Render it only while it is open. */
export function RenameWorkspaceDialog({
  name,
  onSubmit,
  onClose,
}: RenameWorkspaceDialogProps) {
  // Local state, not the form's error map: a stale onSubmit error there would
  // keep the form invalid and block a retry until a field changed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { name } satisfies WorkspaceNameFormData,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: workspaceNameFormSchema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      try {
        await onSubmit(value.name);
      } catch (err) {
        setSubmitError(
          getServerErrorMessage(err, "Failed to rename the workspace"),
        );
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form.AppForm>
          <form.Form className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Rename workspace</DialogTitle>
              <DialogDescription>
                The name every member sees in the organization switcher and in
                invitations.
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Name"
                  placeholder="Acme Corp"
                  autoFocus
                  maxLength={MAX_ORGANIZATION_NAME_LENGTH}
                />
              )}
            </form.AppField>
            {submitError ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <form.SubmitButton>Save</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
