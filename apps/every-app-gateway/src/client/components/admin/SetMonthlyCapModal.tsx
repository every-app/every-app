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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { getServerErrorMessage } from "@/client/errors";
import { formatCount } from "@/client/lib/usage";
import { setAppMonthlyCap } from "@/serverFunctions/usage";
import type { UsageAppRow } from "@/types/usage";

// The same range the server enforces (AppCapService).
const CAP_MIN = 1;
const CAP_MAX = 1_000_000_000;

const setMonthlyCapSchema = z.object({
  cap: z
    .string()
    .trim()
    .regex(/^\d+$/, "Enter a whole number of calls, or remove the cap.")
    .refine(
      (value) => {
        const cap = Number(value);
        return cap >= CAP_MIN && cap <= CAP_MAX;
      },
      `Enter a number from ${CAP_MIN} to ${formatCount(CAP_MAX)}.`,
    ),
});

interface SetMonthlyCapModalProps {
  app: UsageAppRow;
  /** The row is the current UTC month's: its calls count toward the cap. */
  isCurrentMonth: boolean;
  onClose: () => void;
  /** After a cap was set or cleared: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Sets or clears the organization's monthly cap on an app's provider
 * calls. Render it only while it is open.
 */
export function SetMonthlyCapModal({
  app,
  isCurrentMonth,
  onClose,
  onSaved,
}: SetMonthlyCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const name = app.name ?? app.appRowId;

  const save = async (cap: number | null) => {
    setError(null);
    try {
      await setAppMonthlyCap({ data: { appRowId: app.appRowId, cap } });
      toast.success(
        cap === null
          ? `${name} has no monthly cap`
          : `${name} is capped at ${formatCount(cap)} provider calls a month`,
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to update the cap"));
    }
  };

  const form = useAppForm({
    defaultValues: {
      cap: app.monthlyCallCap === null ? "" : String(app.monthlyCallCap),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setMonthlyCapSchema },
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

  // The cap is on the current month: a past month's count says nothing
  // about how far into it the app is.
  const today =
    app.monthlyCallCap === null
      ? "No cap today: the app's calls are unlimited."
      : isCurrentMonth
        ? `Today ${formatCount(app.monthlyCallCap)}; this month ${formatCount(app.calls)} so far.`
        : `Today ${formatCount(app.monthlyCallCap)}.`;

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
              <DialogTitle>Monthly cap</DialogTitle>
              <DialogDescription>
                Provider calls {name} may make for this organization in a UTC
                month: AI providers and capabilities, counted together. Once
                reached, the gateway refuses the app's calls until the month
                ends or the cap is raised.
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="cap">
              {(field) => (
                <field.TextField
                  label="Calls per month"
                  description={today}
                  type="number"
                  inputMode="numeric"
                  min={CAP_MIN}
                  max={CAP_MAX}
                  step={1}
                  placeholder="5000"
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
                    {app.monthlyCallCap !== null ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="mr-auto"
                        disabled={isSubmitting}
                        pending={isRemoving}
                        onClick={() => void remove()}
                      >
                        Remove cap
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
