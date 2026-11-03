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
import { formatCostCap, formatCostMicros } from "@/client/lib/usage";
import { setAppMonthlyCap } from "@/serverFunctions/usage";
import type { UsageAppRow } from "@/types/usage";
import { CapDialogDescription } from "./CapDialogDescription";
import {
  COST_CAP_HELP,
  COST_CAP_MAX_USD,
  COST_CAP_MIN_USD,
  checkCostCapField,
  costCapFieldValue,
  fieldDollars,
} from "./capField";

/**
 * What binds the app once a workspace default exists: the default (no
 * row of its own), nothing at all (its row says unlimited), or a cap of
 * its own.
 */
type CapMode = "default" | "none" | "custom";

const setMonthlyCapSchema = z
  .object({
    mode: z.enum(["default", "none", "custom"]),
    costUsd: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "custom") checkCostCapField(value, ctx);
  });

interface SetMonthlyCapModalProps {
  app: UsageAppRow;
  /** The workspace default cap in micro-dollars, or null. */
  defaultCostCapMicros: number | null;
  /** The row is the current UTC month's: its cost counts toward the cap. */
  isCurrentMonth: boolean;
  onClose: () => void;
  /** After a cap was set or cleared: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Sets or clears the organization's monthly cap in dollars of
 * provider-reported cost on an app's provider calls. With a workspace
 * default, the choice is the default, no cap, or a cap of the app's own;
 * without one, the field and Remove cap. Opened from Raise on a paused
 * app, it starts on a cap of its own prefilled with what binds today, the
 * default included: the raise is an override for this app, and the
 * default itself is changed in its own row. Render it only while it is
 * open.
 */
export function SetMonthlyCapModal({
  app,
  defaultCostCapMicros,
  isCurrentMonth,
  onClose,
  onSaved,
}: SetMonthlyCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const id = useId();
  const name = app.name ?? app.appRowId;
  const hasDefault = defaultCostCapMicros !== null;
  const hasOwnCap = app.monthlyCostCapMicros !== null;
  // `paused` is only ever true for the current month.
  const raising = app.paused;

  const save = async (costUsd: number | null, unlimited = false) => {
    setError(null);
    try {
      await setAppMonthlyCap({
        data: {
          appRowId: app.appRowId,
          costUsd,
          ...(unlimited && { unlimited }),
        },
      });
      toast.success(
        costUsd !== null
          ? `${name} is capped at ${formatCostCap(Math.round(costUsd * 1_000_000))} a month`
          : !unlimited && defaultCostCapMicros !== null
            ? `${name} uses the workspace default of ${formatCostCap(defaultCostCapMicros)} a month`
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
      mode: (!hasDefault || raising || hasOwnCap
        ? "custom"
        : app.capUnlimited
          ? "none"
          : "default") as CapMode,
      costUsd: costCapFieldValue(
        raising ? app.effectiveMonthlyCostCapMicros : app.monthlyCostCapMicros,
      ),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setMonthlyCapSchema },
    onSubmit: async ({ value }) => {
      if (value.mode === "default") await save(null);
      else if (value.mode === "none") await save(null, true);
      else await save(fieldDollars(value.costUsd));
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
    ? `${formatCostMicros(app.costMicros)} so far this month.`
    : undefined;

  const options: { value: CapMode; label: string }[] = [
    {
      value: "default",
      label: `Workspace default (${formatCostCap(defaultCostCapMicros ?? 0)})`,
    },
    { value: "none", label: "No cap" },
    { value: "custom", label: "Custom cap" },
  ];

  const capField = (
    <form.AppField name="costUsd">
      {(field) => (
        <field.TextField
          label="Dollars per month"
          description={soFar ? `${COST_CAP_HELP} ${soFar}` : COST_CAP_HELP}
          type="number"
          inputMode="decimal"
          min={COST_CAP_MIN_USD}
          max={COST_CAP_MAX_USD}
          step={0.01}
          placeholder="20"
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
            {raising && app.costCapSource === "default" ? (
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
                    {!hasDefault && hasOwnCap ? (
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
