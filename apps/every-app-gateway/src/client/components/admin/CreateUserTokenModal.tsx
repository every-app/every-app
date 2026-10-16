import { useMemo, useState } from "react";
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
import type { AppWithAccessCount } from "@/types/app";
import {
  DAY_MS,
  EXPIRY_CHOICES,
  EXPIRY_ITEMS,
  expiryToIso,
  localDateTimeValue,
  msUntil,
  type ExpiryChoice,
} from "./tokenExpiry";

// The server rejects longer names.
const MAX_NAME_LENGTH = 64;

// The app scope select needs a real value for "no app".
const ALL_APPS = "all";

const createUserTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter a name.")
      .max(MAX_NAME_LENGTH, `Use ${MAX_NAME_LENGTH} characters or fewer.`),
    appId: z.string(),
    expiry: z.enum(EXPIRY_CHOICES),
    customExpiresAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.expiry !== "custom") return;
    // The same window the server enforces.
    const ms = msUntil(value.customExpiresAt);
    if (ms === null || ms < DAY_MS || ms > 365 * DAY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customExpiresAt"],
        message:
          ms === null
            ? "Pick an expiration date."
            : "Expiration must be between 1 day and 1 year from now.",
      });
    }
  });

interface CreateUserTokenModalProps {
  onClose: () => void;
  apps: AppWithAccessCount[];
  onCreate: (input: {
    name: string;
    appId?: string;
    expiresAt?: string;
  }) => Promise<void>;
}

/** Creates a personal access token. Render it only while open. */
export function CreateUserTokenModal({
  onClose,
  apps,
  onCreate,
}: CreateUserTokenModalProps) {
  const appItems = useMemo(
    () => [
      { value: ALL_APPS, label: "All my apps" },
      ...[...apps]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((app) => ({ value: app.id, label: `${app.name} (${app.appId})` })),
    ],
    [apps],
  );
  const [error, setError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: {
      name: "",
      appId: ALL_APPS,
      expiry: "90" as ExpiryChoice,
      customExpiresAt: localDateTimeValue(90),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: createUserTokenSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onCreate({
          name: value.name,
          appId: value.appId === ALL_APPS ? undefined : value.appId,
          expiresAt: expiryToIso(value.expiry, value.customExpiresAt),
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
              <DialogTitle>Create personal access token</DialogTitle>
              <DialogDescription>
                For Claude Code, Cursor, and API clients. claude.ai connectors
                need the OAuth connector (coming later).
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Name"
                  placeholder="Claude Code on MacBook"
                  maxLength={MAX_NAME_LENGTH}
                  required
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="appId">
              {(field) => (
                <field.SelectField label="App scope" items={appItems} />
              )}
            </form.AppField>
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
              <form.SubmitButton>Create token</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
