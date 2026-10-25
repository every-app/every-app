import { useId, useState } from "react";
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
import { Field, FieldLabel } from "@/client/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/client/components/ui/radio-group";
import { getServerErrorMessage } from "@/client/errors";
import { formatCount } from "@/client/lib/usage";
import { setAppMonthlyCap } from "@/serverFunctions/usage";
import type { UsageAppRow } from "@/types/usage";
import { CapDialogDescription } from "./CapDialogDescription";
import { CAP_MAX, CAP_MIN, capFieldSchema } from "./capField";

/**
 * What binds the app once a workspace default exists: the default (no row
 * of its own), nothing at all (its row says unlimited), or its own cap.
 */
type CapMode = "default" | "none" | "custom";

const setMonthlyCapSchema = z
  .object({
    mode: z.enum(["default", "none", "custom"]),
    cap: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "custom") return;
    const result = capFieldSchema.safeParse(value.cap);
    if (result.success) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cap"],
      message: result.error.issues[0]?.message ?? "Enter a whole number.",
    });
  });

interface SetMonthlyCapModalProps {
  app: UsageAppRow;
  /** The workspace default, or null: with one, the dialog offers the three-way choice. */
  defaultCap: number | null;
  /** The row is the current UTC month's: its calls count toward the cap. */
  isCurrentMonth: boolean;
  onClose: () => void;
  /** After a cap was set or cleared: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Sets or clears the organization's monthly cap on an app's provider
 * calls. With a workspace default, the choice is the default, no cap, or
 * a cap of the app's own; without one, a number or Remove cap. Opened
 * from Raise on a paused app, it starts on a custom cap prefilled with
 * what binds today, the default included: the raise is an override for
 * this app, and the default itself is changed in its own row. Render it
 * only while it is open.
 */
export function SetMonthlyCapModal({
  app,
  defaultCap,
  isCurrentMonth,
  onClose,
  onSaved,
}: SetMonthlyCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const id = useId();
  const name = app.name ?? app.appRowId;
  const hasDefault = defaultCap !== null;
  // `paused` is only ever true for the current month.
  const raising = app.paused;

  const save = async (cap: number | null, unlimited = false) => {
    setError(null);
    try {
      await setAppMonthlyCap({
        data: { appRowId: app.appRowId, cap, ...(unlimited && { unlimited }) },
      });
      toast.success(
        cap !== null
          ? `${name} is capped at ${formatCount(cap)} provider calls a month`
          : !unlimited && hasDefault
            ? `${name} uses the default cap of ${formatCount(defaultCap)} provider calls a month`
            : `${name} has no monthly cap`,
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to update the cap"));
    }
  };

  const form = useAppForm({
    defaultValues: {
      mode: (!hasDefault || raising || app.capSource === "app"
        ? "custom"
        : app.capUnlimited
          ? "none"
          : "default") as CapMode,
      cap: raising
        ? String(app.effectiveMonthlyCallCap)
        : app.monthlyCallCap === null
          ? ""
          : String(app.monthlyCallCap),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setMonthlyCapSchema },
    onSubmit: async ({ value }) => {
      if (value.mode === "default") await save(null);
      else if (value.mode === "none") await save(null, true);
      else await save(Number(value.cap.trim()));
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

  // How far into the month the app is: only for the current month, since a
  // past month's count says nothing about it.
  const soFar = isCurrentMonth
    ? `${formatCount(app.calls)} so far this month.`
    : undefined;

  const options: { value: CapMode; label: string }[] = [
    {
      value: "default",
      label: `Workspace default (${formatCount(defaultCap ?? 0)} calls)`,
    },
    { value: "none", label: "No cap" },
    { value: "custom", label: "Custom cap" },
  ];

  const capField = (
    <form.AppField name="cap">
      {(field) => (
        <field.TextField
          label="Calls per month"
          hideLabel={hasDefault}
          description={soFar}
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
  );

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
              <DialogTitle>
                {raising
                  ? `Raise the monthly cap for ${name}`
                  : `Monthly cap for ${name}`}
              </DialogTitle>
              <CapDialogDescription />
            </DialogHeader>
            {hasDefault ? (
              <form.AppField name="mode">
                {(field) => (
                  <RadioGroup
                    aria-label="Monthly cap"
                    value={field.state.value}
                    onValueChange={(value) =>
                      field.handleChange(value as CapMode)
                    }
                  >
                    {options.map((option) => (
                      <Field key={option.value} orientation="horizontal">
                        <RadioGroupItem
                          value={option.value}
                          id={`${id}-${option.value}`}
                        />
                        <FieldLabel
                          htmlFor={`${id}-${option.value}`}
                          className="font-normal"
                        >
                          {option.label}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                )}
              </form.AppField>
            ) : null}
            <form.Subscribe selector={(state) => state.values.mode}>
              {(mode) =>
                mode === "custom" ? (
                  <div className={hasDefault ? "pl-6" : undefined}>
                    {capField}
                  </div>
                ) : soFar ? (
                  <p className="text-xs text-muted-foreground">{soFar}</p>
                ) : null
              }
            </form.Subscribe>
            {raising && app.capSource === "default" ? (
              <p className="text-xs text-muted-foreground">
                The default itself is changed in the Default monthly cap row.
              </p>
            ) : null}
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
                    {!hasDefault && app.monthlyCallCap !== null ? (
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
