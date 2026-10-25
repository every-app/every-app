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
import { formatCostCap, formatCount } from "@/client/lib/usage";
import { setDefaultMonthlyCap } from "@/serverFunctions/usage";
import { CapDialogDescription } from "./CapDialogDescription";
import {
  CAP_MAX,
  CAP_MIN,
  COST_CAP_HELP,
  COST_CAP_MAX_USD,
  COST_CAP_MIN_USD,
  checkCapFields,
  costCapFieldValue,
  fieldNumber,
} from "./capField";

const setDefaultCapSchema = z
  .object({ cap: z.string(), costUsd: z.string() })
  .superRefine(checkCapFields);

interface SetDefaultCapModalProps {
  /** The workspace default call cap today, or null for none. */
  defaultCap: number | null;
  /** The workspace default dollar cap today in micro-dollars, or null for none. */
  defaultCostCapMicros: number | null;
  onClose: () => void;
  /** After the defaults were set or removed: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Sets or removes the organization's default monthly caps (a number of
 * calls, dollars of provider-reported cost, or both), which bind every
 * app without a cap of that kind or "no cap" of its own. A field left
 * empty is no default of that kind. Render it only while it is open.
 */
export function SetDefaultCapModal({
  defaultCap,
  defaultCostCapMicros,
  onClose,
  onSaved,
}: SetDefaultCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const save = async (caps: { cap: number | null; costUsd: number | null }) => {
    setError(null);
    try {
      await setDefaultMonthlyCap({ data: caps });
      const words = [
        caps.cap === null ? null : `${formatCount(caps.cap)} provider calls`,
        caps.costUsd === null
          ? null
          : formatCostCap(Math.round(caps.costUsd * 1_000_000)),
      ]
        .filter(Boolean)
        .join(" or ");
      toast.success(
        words
          ? `Every app without its own cap is capped at ${words} a month`
          : "No default monthly cap",
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to update the default cap"));
    }
  };

  const form = useAppForm({
    defaultValues: {
      cap: defaultCap === null ? "" : String(defaultCap),
      costUsd: costCapFieldValue(defaultCostCapMicros),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setDefaultCapSchema },
    onSubmit: async ({ value }) => {
      await save({
        cap: fieldNumber(value.cap),
        costUsd: fieldNumber(value.costUsd),
      });
    },
  });

  const remove = async () => {
    setIsRemoving(true);
    try {
      await save({ cap: null, costUsd: null });
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
            <form.AppField name="costUsd">
              {(field) => (
                <field.TextField
                  label="or dollars per month"
                  description={COST_CAP_HELP}
                  type="number"
                  inputMode="decimal"
                  min={COST_CAP_MIN_USD}
                  max={COST_CAP_MAX_USD}
                  step={0.01}
                  placeholder="20"
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
                    {defaultCap !== null || defaultCostCapMicros !== null ? (
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
