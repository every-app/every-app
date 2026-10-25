import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { getServerErrorMessage } from "@/client/errors";
import { formatCount } from "@/client/lib/usage";
import { setDefaultMonthlyCap } from "@/serverFunctions/usage";
import { CapDialogDescription } from "./CapDialogDescription";
import { CAP_MAX, CAP_MIN, capFieldSchema } from "./capField";

const setDefaultCapSchema = z.object({ cap: capFieldSchema });

interface SetDefaultCapModalProps {
  /** The workspace default today, or null for none. */
  defaultCap: number | null;
  onClose: () => void;
  /** After the default was set or removed: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Sets or removes the organization's default monthly cap, which binds
 * every app without a cap or "no cap" of its own. Render it only while it
 * is open.
 */
export function SetDefaultCapModal({
  defaultCap,
  onClose,
  onSaved,
}: SetDefaultCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const save = async (cap: number | null) => {
    setError(null);
    try {
      await setDefaultMonthlyCap({ data: { cap } });
      toast.success(
        cap === null
          ? "No default monthly cap"
          : `Every app without its own cap is capped at ${formatCount(cap)} provider calls a month`,
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to update the default cap"));
    }
  };

  const form = useAppForm({
    defaultValues: { cap: defaultCap === null ? "" : String(defaultCap) },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setDefaultCapSchema },
    onSubmit: async ({ value }) => {
      await save(Number(value.cap.trim()));
    },
  });

  const remove = async () => {
    setIsRemoving(true);
    try {
      await save(null);
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.state.isSubmitting && !isRemoving) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form.AppForm>
          <form.Form className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Default monthly cap</DialogTitle>
              <CapDialogDescription />
            </DialogHeader>
            <form.AppField name="cap">
              {(field) => (
                <field.TextField
                  label="Calls per month, for every app without its own cap"
                  type="number"
                  inputMode="numeric"
                  min={CAP_MIN}
                  max={CAP_MAX}
                  step={1}
                  placeholder="1000"
                  autoFocus
                />
              )}
            </form.AppField>
            {error ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <>
                    {defaultCap !== null ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="mr-auto"
                        disabled={isSubmitting}
                        pending={isRemoving}
                        onClick={() => void remove()}
                      >
                        Remove default
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isSubmitting || isRemoving}
                      onClick={onClose}
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </form.Subscribe>
              <form.SubmitButton disabled={isRemoving}>Save</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
