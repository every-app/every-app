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
import { getServerErrorMessage } from "@/client/errors";
import { groupFormSchema, type GroupFormData } from "@/schemas/group";
import type { AdminGroup } from "@/types/group";

interface GroupDialogProps {
  /** The group to edit, or null to create one. */
  group: AdminGroup | null;
  onSubmit: (values: GroupFormData) => Promise<void>;
  onClose: () => void;
}

/** Creates or renames a group. Render it only while it is open. */
export function GroupDialog({ group, onSubmit, onClose }: GroupDialogProps) {
  // Local state, not the form's error map: a stale onSubmit error there would
  // keep the form invalid and block a retry until a field changed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: {
      name: group?.name ?? "",
      description: group?.description ?? "",
    } satisfies GroupFormData,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: groupFormSchema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      try {
        await onSubmit(value);
      } catch (err) {
        setSubmitError(
          getServerErrorMessage(
            err,
            group ? "Failed to update group" : "Failed to create group",
          ),
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
              <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
              <DialogDescription>
                {group
                  ? "Rename the group or change its description."
                  : "A named set of members. Grant apps to the group and everyone in it can open them."}
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Name"
                  placeholder="Sales"
                  autoFocus
                  maxLength={60}
                />
              )}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextareaField
                  label="Description"
                  description="Optional. Who is in it, or what it is for."
                  placeholder="Everyone on the sales team"
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
              <form.SubmitButton>
                {group ? "Save changes" : "Create group"}
              </form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
