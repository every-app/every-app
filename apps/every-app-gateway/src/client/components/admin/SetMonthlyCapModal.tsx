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
import {
  formatCostCap,
  formatCostMicros,
  formatCount,
} from "@/client/lib/usage";
import { setAppMonthlyCap } from "@/serverFunctions/usage";
import type { UsageAppRow } from "@/types/usage";
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

/**
 * What binds the app once a workspace default exists: the defaults (no
 * row of its own), nothing at all (its row says unlimited), or caps of
 * its own.
 */
type CapMode = "default" | "none" | "custom";

const setMonthlyCapSchema = z
  .object({
    mode: z.enum(["default", "none", "custom"]),
    cap: z.string(),
    costUsd: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "custom") checkCapFields(value, ctx);
  });

interface SetMonthlyCapModalProps {
  app: UsageAppRow;
  /** The workspace default call cap, or null. */
  defaultCap: number | null;
  /** The workspace default dollar cap in micro-dollars, or null. */
  defaultCostCapMicros: number | null;
  /** The row is the current UTC month's: its calls count toward the cap. */
  isCurrentMonth: boolean;
  onClose: () => void;
  /** After a cap was set or cleared: the usage view reloads. */
  onSaved: () => void;
}

/** "1,000 calls", "$20.00", or both: what a pair of caps says in a label or a toast. */
function capsWords(cap: number | null, costMicros: number | null): string {
  return [
    cap === null ? null : `${formatCount(cap)} calls`,
    costMicros === null ? null : formatCostCap(costMicros),
  ]
    .filter(Boolean)
    .join(" or ");
}

/**
 * Sets or clears the organization's monthly caps on an app's provider
 * calls: a number of calls, dollars of provider-reported cost, or both
 * (the app is paused at whichever it reaches first). With a workspace
 * default (of either kind), the choice is the defaults, no cap, or caps
 * of the app's own, where a field left empty follows the default of its
 * kind; without one, the two fields and Remove cap. Opened from Raise on
 * a paused app, it starts on caps of its own prefilled with what binds
 * today, the defaults included: the raise is an override for this app,
 * and the defaults themselves are changed in their own row. Render it
 * only while it is open.
 */
export function SetMonthlyCapModal({
  app,
  defaultCap,
  defaultCostCapMicros,
  isCurrentMonth,
  onClose,
  onSaved,
}: SetMonthlyCapModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const id = useId();
  const name = app.name ?? app.appRowId;
  const hasDefault = defaultCap !== null || defaultCostCapMicros !== null;
  const hasOwnCap =
    app.monthlyCallCap !== null || app.monthlyCostCapMicros !== null;
  // `paused` is only ever true for the current month.
  const raising = app.paused;

  const save = async (
    caps: { cap: number | null; costUsd: number | null },
    unlimited = false,
  ) => {
    setError(null);
    try {
      await setAppMonthlyCap({
        data: {
          appRowId: app.appRowId,
          ...caps,
          ...(unlimited && { unlimited }),
        },
      });
      const own = capsWords(
        caps.cap,
        caps.costUsd === null ? null : Math.round(caps.costUsd * 1_000_000),
      );
      toast.success(
        own
          ? `${name} is capped at ${own} a month`
          : !unlimited && hasDefault
            ? `${name} uses the workspace default of ${capsWords(defaultCap, defaultCostCapMicros)} a month`
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
      cap: raising
        ? app.effectiveMonthlyCallCap === null
          ? ""
          : String(app.effectiveMonthlyCallCap)
        : app.monthlyCallCap === null
          ? ""
          : String(app.monthlyCallCap),
      costUsd: costCapFieldValue(
        raising ? app.effectiveMonthlyCostCapMicros : app.monthlyCostCapMicros,
      ),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setMonthlyCapSchema },
    onSubmit: async ({ value }) => {
      if (value.mode === "default") await save({ cap: null, costUsd: null });
      else if (value.mode === "none") {
        await save({ cap: null, costUsd: null }, true);
      } else {
        await save({
          cap: fieldNumber(value.cap),
          costUsd: fieldNumber(value.costUsd),
        });
      }
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

  // How far into the month the app is: only for the current month, since a
  // past month's count says nothing about it.
  const soFar = isCurrentMonth
    ? `${formatCount(app.calls)} so far this month.`
    : undefined;
  const costSoFar = isCurrentMonth
    ? ` ${formatCostMicros(app.costMicros)} so far this month.`
    : "";

  const options: { value: CapMode; label: string }[] = [
    {
      value: "default",
      label: `Workspace default (${capsWords(defaultCap, defaultCostCapMicros)})`,
    },
    { value: "none", label: "No cap" },
    { value: "custom", label: "Custom cap" },
  ];

  const capFields = (
    <div className="flex flex-col gap-3">
      <form.AppField name="cap">
        {(field) => (
          <field.TextField
            label="Calls per month"
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
      <form.AppField name="costUsd">
        {(field) => (
          <field.TextField
            label="or dollars per month"
            description={`${COST_CAP_HELP}${costSoFar}`}
            type="number"
            inputMode="decimal"
            min={COST_CAP_MIN_USD}
            max={COST_CAP_MAX_USD}
            step={0.01}
            placeholder="20"
          />
        )}
      </form.AppField>
    </div>
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
                    {capFields}
                    {hasDefault ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        A field left empty follows the workspace default.
                      </p>
                    ) : null}
                  </div>
                ) : soFar ? (
                  <p className="text-xs text-muted-foreground">{soFar}</p>
                ) : null
              }
            </form.Subscribe>
            {raising &&
            (app.capSource === "default" || app.costCapSource === "default") ? (
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
