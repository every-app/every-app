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

// A deploy key: `everyapp deploy --gateway` in CI, nothing else
// (server/deploy/). It opens no app and no MCP connection.
const DEPLOY_SCOPE = "deploy";

const KIND_ITEMS = [
  { value: "access", label: "Access token (MCP and API clients)" },
  { value: "deploy", label: "Deploy key (everyapp deploy in CI)" },
];

const createUserTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter a name.")
      .max(MAX_NAME_LENGTH, `Use ${MAX_NAME_LENGTH} characters or fewer.`),
    kind: z.enum(["access", "deploy"]),
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
  /** The gateway takes third-party deploys, so deploy keys are offered. */
  allowDeployKeys?: boolean;
  onCreate: (input: {
    name: string;
    appId?: string;
    scopes?: string[];
    expiresAt?: string;
  }) => Promise<void>;
}

/** Creates a personal access token. Render it only while open. */
export function CreateUserTokenModal({
  onClose,
  apps,
  allowDeployKeys = false,
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
      kind: "access" as "access" | "deploy",
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
          ...(value.kind === "deploy" ? { scopes: [DEPLOY_SCOPE] } : {}),
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
            {allowDeployKeys ? (
              <form.AppField
                name="kind"
                listeners={{
                  // Deploy keys sit in CI: a shorter default.
                  onChange: ({ value }) =>
                    form.setFieldValue(
                      "expiry",
                      value === "deploy" ? "30" : "90",
                    ),
                }}
              >
                {(field) => (
                  <field.SelectField label="Kind" items={KIND_ITEMS} />
                )}
              </form.AppField>
            ) : null}
            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) => (
                <form.AppField name="appId">
                  {(field) => (
                    <field.SelectField
                      label={kind === "deploy" ? "Deploys" : "App scope"}
                      items={
                        kind === "deploy"
                          ? [
                              {
                                value: ALL_APPS,
                                label: "Any app of this organization",
                              },
                              ...appItems.slice(1),
                            ]
                          : appItems
                      }
                    />
                  )}
                </form.AppField>
              )}
            </form.Subscribe>
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
