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
import {
  TOKEN_ACCESS,
  TOKEN_EXPIRY_DAYS,
  type TokenAccess,
  type TokenExpiryDays,
} from "@/server/user-pat-scopes";
import type { AppWithAccessCount } from "@/types/app";

// The server rejects longer names.
const MAX_NAME_LENGTH = 64;

// The app select needs a real value for "no app".
const ALL_APPS = "all";

const ACCESS_ITEMS: { value: TokenAccess; label: string }[] = [
  { value: "read", label: "Read only (MCP tools that read)" },
  { value: "full", label: "Full access (acts as you everywhere)" },
];
// A deploy key: `everyapp deploy --gateway` in CI, nothing else
// (server/deploy/). It opens no app and no MCP connection. Offered only
// where the gateway takes third-party deploys.
const DEPLOY_ITEM = {
  value: "deploy" as const,
  label: "Deploy key (everyapp deploy in CI)",
};

const EXPIRY_ITEMS = TOKEN_EXPIRY_DAYS.map((days) => ({
  value: String(days),
  label: days === 365 ? "1 year" : `${days} days`,
}));

// Every token starts with a month; a longer one is a choice.
const DEFAULT_EXPIRY = "30";

const createUserTokenSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .max(MAX_NAME_LENGTH, `Use ${MAX_NAME_LENGTH} characters or fewer.`),
  access: z.enum(TOKEN_ACCESS),
  appId: z.string(),
  expiry: z.enum(EXPIRY_ITEMS.map((item) => item.value)),
});

interface CreateUserTokenModalProps {
  onClose: () => void;
  apps: AppWithAccessCount[];
  /** The gateway takes third-party deploys, so deploy keys are offered. */
  allowDeployKeys?: boolean;
  onCreate: (input: {
    name: string;
    access: TokenAccess;
    appId?: string;
    expiresInDays: TokenExpiryDays;
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
    () =>
      [...apps]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((app) => ({ value: app.id, label: `${app.name} (${app.appId})` })),
    [apps],
  );
  const accessItems = allowDeployKeys
    ? [...ACCESS_ITEMS, DEPLOY_ITEM]
    : ACCESS_ITEMS;
  const [error, setError] = useState<string | null>(null);
  // One app where there is one: a token for every app is a choice.
  const defaultAppId = apps.length === 1 ? apps[0]!.id : ALL_APPS;

  const form = useAppForm({
    defaultValues: {
      name: "",
      access: "read" as TokenAccess,
      appId: defaultAppId,
      expiry: DEFAULT_EXPIRY,
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: createUserTokenSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onCreate({
          name: value.name,
          access: value.access,
          appId: value.appId === ALL_APPS ? undefined : value.appId,
          expiresInDays: Number(value.expiry) as TokenExpiryDays,
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
                <Link to="/connections/agents">Your connections</Link> instead.
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
            <form.AppField name="access">
              {(field) => (
                <field.SelectField label="Access" items={accessItems} />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.access}>
              {(access) =>
                access === "full" ? (
                  <Alert variant="destructive">
                    <CircleAlert aria-hidden />
                    <AlertDescription>
                      Full access acts as you on every app route and every MCP
                      tool, deleting included, until it expires or is revoked.
                      Limit it to one app where you can.
                    </AlertDescription>
                  </Alert>
                ) : null
              }
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values.access}>
              {(access) => (
                <form.AppField name="appId">
                  {(field) => (
                    <field.SelectField
                      label="Apps"
                      items={[
                        {
                          value: ALL_APPS,
                          label:
                            access === "deploy"
                              ? "Any app of this organization"
                              : "All my apps",
                        },
                        ...appItems,
                      ]}
                    />
                  )}
                </form.AppField>
              )}
            </form.Subscribe>
            <form.AppField name="expiry">
              {(field) => (
                <field.SelectField label="Expires in" items={EXPIRY_ITEMS} />
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
