import { useMemo, useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
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

/**
 * What an access token may do, least first. The server stores the scopes as
 * sent (`*` stays an explicit choice it accepts); an AI client that only
 * reads should never hold more than `mcp:read`.
 */
const ACCESS_CHOICES = ["read", "write", "full"] as const;
type AccessChoice = (typeof ACCESS_CHOICES)[number];
export const ACCESS_SCOPES: Record<AccessChoice, string[]> = {
  read: ["mcp:read"],
  write: ["mcp:write"],
  full: ["*"],
};
const ACCESS_ITEMS: { value: AccessChoice; label: string }[] = [
  { value: "read", label: "Read only (MCP tools that read)" },
  { value: "write", label: "Read & write (MCP tools; never delete)" },
  { value: "full", label: "Full access (every app route and MCP)" },
];

// Every token starts with a month; a longer one is a choice.
const DEFAULT_EXPIRY: ExpiryChoice = "30";

const createUserTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter a name.")
      .max(MAX_NAME_LENGTH, `Use ${MAX_NAME_LENGTH} characters or fewer.`),
    kind: z.enum(["access", "deploy"]),
    access: z.enum(ACCESS_CHOICES),
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
  // One app where there is one: a token for every app is a choice.
  const defaultAppId = apps.length === 1 ? apps[0]!.id : ALL_APPS;

  const form = useAppForm({
    defaultValues: {
      name: "",
      kind: "access" as "access" | "deploy",
      access: "read" as AccessChoice,
      appId: defaultAppId,
      expiry: DEFAULT_EXPIRY,
      customExpiresAt: localDateTimeValue(Number(DEFAULT_EXPIRY)),
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: createUserTokenSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onCreate({
          name: value.name,
          appId: value.appId === ALL_APPS ? undefined : value.appId,
          // Always explicit: the server's own default for omitted scopes
          // is `*`, which this dialog never relies on.
          scopes:
            value.kind === "deploy"
              ? [DEPLOY_SCOPE]
              : ACCESS_SCOPES[value.access],
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
              <DialogTitle>New token</DialogTitle>
              <DialogDescription>
                For Claude Code, Cursor and API clients. claude.ai and ChatGPT
                connect through{" "}
                <Link to="/settings/connections">AI connections</Link> instead.
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
              <form.AppField name="kind">
                {(field) => (
                  <field.SelectField label="Kind" items={KIND_ITEMS} />
                )}
              </form.AppField>
            ) : null}
            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) =>
                kind === "access" ? (
                  <form.AppField name="access">
                    {(field) => (
                      <field.SelectField label="Access" items={ACCESS_ITEMS} />
                    )}
                  </form.AppField>
                ) : null
              }
            </form.Subscribe>
            <form.Subscribe
              selector={(state) =>
                state.values.kind === "access" && state.values.access === "full"
              }
            >
              {(full) =>
                full ? (
                  <Alert variant="destructive">
                    <CircleAlert aria-hidden />
                    <AlertDescription>
                      Full access acts as you on every app route and every MCP
                      tool, read and write, until it expires or is revoked. Most
                      AI clients need read only, or read &amp; write on one app.
                    </AlertDescription>
                  </Alert>
                ) : null
              }
            </form.Subscribe>
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
