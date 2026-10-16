import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert } from "lucide-react";
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
import {
  EXPIRY_CHOICES,
  EXPIRY_ITEMS,
  expiryToIso,
  localDateTimeValue,
  msUntil,
  type ExpiryChoice,
} from "./tokenExpiry";

// The server gives a deploy token 90 days when no expiry is sent, so this
// choice sends null.
const DEFAULT_EXPIRY: ExpiryChoice = "90";

const createAppTokenSchema = z
  .object({
    expiry: z.enum(EXPIRY_CHOICES),
    customExpiresAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.expiry !== "custom") return;
    const ms = msUntil(value.customExpiresAt);
    if (ms === null || ms <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customExpiresAt"],
        message:
          ms === null
            ? "Pick an expiration date."
            : "Expiration date must be in the future.",
      });
    }
  });

interface CreateAppTokenModalProps {
  onClose: () => void;
  onCreate: (input: {
    tokenType: "deploy";
    expiresAt: string | null;
  }) => Promise<void>;
}

/** Creates an organization deploy token. Render it only while open. */
export function CreateAppTokenModal({
  onClose,
  onCreate,
}: CreateAppTokenModalProps) {
  const [error, setError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: {
      expiry: DEFAULT_EXPIRY as ExpiryChoice,
      customExpiresAt: localDateTimeValue(90),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: createAppTokenSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onCreate({
          tokenType: "deploy",
          expiresAt:
            value.expiry === DEFAULT_EXPIRY
              ? null
              : expiryToIso(value.expiry, value.customExpiresAt),
        });
      } catch (err) {
        setError(getServerErrorMessage(err, "Failed to create token"));
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.state.isSubmitting) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form.AppForm>
          <form.Form className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Create deploy token</DialogTitle>
              <DialogDescription>
                Generate an organization-scoped token for CLI deploys. It can
                register apps during{" "}
                <code className="font-mono text-xs">everyapp deploy</code>.
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="expiry">
              {(field) => (
                <field.SelectField label="Expiration" items={EXPIRY_ITEMS} />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.expiry}>
              {(expiry) =>
                expiry === "custom" ? (
                  <form.AppField name="customExpiresAt">
                    {(field) => (
                      <field.TextField
                        label="Expires at"
                        type="datetime-local"
                        required
                      />
                    )}
                  </form.AppField>
                ) : null
              }
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
                  <Button
                    variant="ghost"
                    onClick={onClose}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                )}
              </form.Subscribe>
              <form.SubmitButton>Create deploy token</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
