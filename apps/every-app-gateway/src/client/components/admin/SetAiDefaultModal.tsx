import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { parseAiDefaultChoice } from "@every-app/sdk/internal";
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
import { setAiDefault, type getAiDefault } from "@/serverFunctions/ai";

/** What `getAiDefault` and `setAiDefault` answer: the resolution, the stored choice, AI Gateway. */
export type AiDefaultReport = Awaited<ReturnType<typeof getAiDefault>>;

/** The same bound the server enforces on a model id. */
const AI_MODEL_MAX = 200;

const setAiDefaultSchema = z.object({
  provider: z.string().min(1, "Choose a provider."),
  model: z
    .string()
    .trim()
    .max(AI_MODEL_MAX, `A model id is at most ${AI_MODEL_MAX} characters.`),
});

interface SetAiDefaultModalProps {
  /** What the default resolves to now, with every candidate. */
  report: AiDefaultReport;
  onClose: () => void;
  /** After the choice was stored or cleared: the usage view reloads. */
  onSaved: () => void;
}

/**
 * Chooses the organization's default model provider (and optionally its
 * model), or clears the choice so the shipped order decides. Render it
 * only while it is open.
 */
export function SetAiDefaultModal({
  report,
  onClose,
  onSaved,
}: SetAiDefaultModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const { resolution } = report;
  const candidates = resolution.candidates;
  const stored = parseAiDefaultChoice(report.choice);
  // The stored choice when the select has it, else what serves now.
  const current =
    stored && candidates.some((c) => c.id === stored.provider)
      ? stored
      : { provider: resolution.provider, model: undefined };

  const items = candidates.map((candidate) => ({
    value: candidate.id,
    label: [
      candidate.label,
      candidate.configured ? "key set" : "key not set",
      candidate.model,
    ].join(" · "),
  }));

  const save = async (choice: { provider: string; model?: string } | null) => {
    setError(null);
    try {
      const next = await setAiDefault({
        data: choice ?? { provider: null },
      });
      toast.success(
        choice === null
          ? `The shipped order decides: ${next.resolution.label}`
          : `AI default: ${next.resolution.label} · ${next.resolution.model}`,
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(getServerErrorMessage(err, "Failed to update the AI default"));
    }
  };

  const form = useAppForm({
    defaultValues: { provider: current.provider, model: current.model ?? "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: setAiDefaultSchema },
    onSubmit: async ({ value }) => {
      const model = value.model.trim();
      await save({ provider: value.provider, ...(model ? { model } : {}) });
    },
  });

  const clear = async () => {
    setIsClearing(true);
    try {
      await save(null);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.state.isSubmitting && !isClearing) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form.AppForm>
          <form.Form className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>AI default</DialogTitle>
              <DialogDescription>
                The provider and model apps get when they ask for a chat model
                without naming one.
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="provider">
              {(field) => <field.SelectField label="Provider" items={items} />}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.provider}>
              {(provider) => (
                <form.AppField name="model">
                  {(field) => (
                    <field.TextField
                      label="Model (optional)"
                      placeholder={
                        candidates.find((c) => c.id === provider)?.model ?? ""
                      }
                      description="Leave empty to keep the provider's model (shown). A model id may contain slashes."
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </form.AppField>
              )}
            </form.Subscribe>
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
                    {report.choice !== null ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="mr-auto"
                        disabled={isSubmitting}
                        pending={isClearing}
                        onClick={() => void clear()}
                      >
                        Use the shipped order
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isSubmitting || isClearing}
                      onClick={onClose}
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </form.Subscribe>
              <form.SubmitButton disabled={isClearing}>Save</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
