import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
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
import { Separator } from "@/client/components/ui/separator";
import { adminAppsCollection } from "@/client/tanstack-db";
import { getServerErrorMessage } from "@/client/errors";
import { editAppSchema, type EditAppFormData } from "@/schemas/app";
import type { AppWithAccessCount } from "@/types/app";

interface EditAppModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
}

/** Edits an app's catalog metadata. Render it only while it is open. */
export function EditAppModal({ app, onClose }: EditAppModalProps) {
  // Local state, not the form's error map: a stale onSubmit error there would
  // keep the form invalid and block a retry until a field changed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const defaultValues: EditAppFormData = {
    name: app.name,
    description: app.description,
    isDefault: app.isDefault,
  };

  const form = useAppForm({
    defaultValues,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: editAppSchema },
    onSubmit: ({ value }) => {
      setSubmitError(null);
      try {
        // Use collection's update method for optimistic update
        adminAppsCollection.update(app.id, (draft) => {
          draft.name = value.name;
          draft.description = value.description;
          draft.isDefault = value.isDefault ?? false;
          draft.updatedAt = new Date();
        });
        onClose();
      } catch (err) {
        setSubmitError(getServerErrorMessage(err, "Failed to update app"));
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
              <DialogTitle>Edit app</DialogTitle>
              <DialogDescription>
                Editing <span className="font-mono">{app.appId}</span>
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="name">
              {(field) => (
                <field.TextField label="App name" placeholder="My App" />
              )}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextareaField
                  label="Description"
                  placeholder="Describe what your app does..."
                />
              )}
            </form.AppField>
            {app.hostname ? (
              <p className="text-sm text-muted-foreground">
                Served at <span className="font-mono">{app.hostname}</span> —
                set by <span className="font-mono">everyapp deploy</span>
              </p>
            ) : null}
            <Separator />
            <form.AppField name="isDefault">
              {(field) => (
                <field.SwitchField
                  label="Available to everyone"
                  description="Every current and future member can open this app. Turning this off keeps existing access; use Manage access to remove people."
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
              <form.SubmitButton>Save changes</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
