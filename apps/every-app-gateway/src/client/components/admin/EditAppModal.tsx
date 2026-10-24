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
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { adminAppsCollection } from "@/client/tanstack-db";
import { getServerErrorMessage } from "@/client/errors";
import { appEmail } from "@/client/lib/appEmail";
import { editAppSchema, type EditAppFormData } from "@/schemas/app";
import type { AppWithAccessCount } from "@/types/app";
import { CapabilitySentence } from "./CapabilitySentence";
import { deployedBy } from "./deployedBy";

interface EditAppModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
}

/** Edits an app's catalog metadata. Render it only while it is open. */
export function EditAppModal({ app, onClose }: EditAppModalProps) {
  // Local state, not the form's error map: a stale onSubmit error there would
  // keep the form invalid and block a retry until a field changed.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Read-only: the lists are set with the CLI, which also makes the routes.
  const email = appEmail(app);

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
                Served at <span className="font-mono">{app.hostname}</span>
              </p>
            ) : null}
            {/* A provider app has no deploy: the Apps table says who turned it on. */}
            {app.tier !== PROVIDER_APP_TIER && app.deployedByActor ? (
              <p className="text-sm text-muted-foreground">
                {deployedBy(app.deployedByActor)}
              </p>
            ) : null}
            {email.sends || email.receives ? (
              <p className="text-sm text-muted-foreground">
                Mail:{" "}
                {email.sends ? (
                  email.senders.length ? (
                    <>
                      sends as{" "}
                      <span className="font-mono">
                        {email.senders.join(", ")}
                      </span>
                    </>
                  ) : (
                    "sends as the gateway's sender only"
                  )
                ) : null}
                {email.sends && email.receives ? " · " : null}
                {email.receives ? (
                  email.inbound.length ? (
                    <>
                      receives{" "}
                      <span className="font-mono">
                        {email.inbound.join(", ")}
                      </span>
                    </>
                  ) : (
                    "receives no addresses yet"
                  )
                ) : null}
              </p>
            ) : null}
            {app.capabilities.length ? (
              <p className="text-sm text-muted-foreground">
                Integrations:{" "}
                {app.capabilities.map((capability, index) => (
                  <span key={capability.id}>
                    {index ? " " : null}
                    <CapabilitySentence capability={capability} />
                  </span>
                ))}
              </p>
            ) : null}
            {app.scope === "shared" ? (
              <p className="text-sm text-muted-foreground">
                A shared app: every member of every organization can open it.
              </p>
            ) : (
              <>
                <Separator />
                <form.AppField name="isDefault">
                  {(field) => (
                    <field.SwitchField
                      label="Available to everyone"
                      description="Grants every current member, and everyone who joins later. Turning it off keeps the people who already have access."
                    />
                  )}
                </form.AppField>
              </>
            )}
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
