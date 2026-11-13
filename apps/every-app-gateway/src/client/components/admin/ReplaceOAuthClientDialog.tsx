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
import { getRuleErrorMessage } from "@/client/errors";
import {
  OAUTH_CLIENT_ID_MAX,
  OAUTH_CLIENT_SECRET_MAX,
} from "@/schemas/oauth-provider";
import { RedirectUriSection } from "./OAuthClientFields";
import { ProviderHosts } from "./ProviderHosts";

const schema = z.object({
  clientId: z
    .string()
    .trim()
    .min(1, "Enter the client ID.")
    .max(OAUTH_CLIENT_ID_MAX, "Too long."),
  clientSecret: z.string().max(OAUTH_CLIENT_SECRET_MAX, "Too long."),
});

interface ReplaceOAuthClientDialogProps {
  provider: {
    id: string;
    name: string;
    redirectUri: string;
    console: string;
    /** The only hosts the Gateway sends the provider's tokens to. */
    hosts: readonly string[];
    /** The live client's source, for the warning about a terminal-set one. */
    clientSource: "env" | "d1" | null;
  };
  onSubmit: (input: {
    clientId: string;
    clientSecret?: string;
  }) => Promise<void>;
  onClose: () => void;
}

/**
 * Pastes a provider's client (first time, or in place of the one pasted
 * before). The secret is sent once and never shown again; a client set
 * from the terminal as a Worker secret keeps winning, which the dialog
 * says. Render it only while it is open.
 */
export function ReplaceOAuthClientDialog({
  provider,
  onSubmit,
  onClose,
}: ReplaceOAuthClientDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: { clientId: "", clientSecret: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onSubmit({
          clientId: value.clientId.trim(),
          ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
        });
      } catch (err) {
        setError(getRuleErrorMessage(err, "Failed to save the client"));
      }
    },
  });
  const replacing = provider.clientSource !== null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form.AppForm>
          <form.Form className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {replacing
                  ? `Replace the ${provider.name} client`
                  : `Set the ${provider.name} client`}
              </DialogTitle>
              {replacing ? (
                <DialogDescription>
                  Existing connections work until they expire. Then people
                  reconnect.
                </DialogDescription>
              ) : null}
            </DialogHeader>

            {provider.clientSource === "env" ? (
              <Alert variant="warning">
                <CircleAlert />
                <AlertDescription>
                  This client was set from a terminal. Change it there with{" "}
                  <span className="font-mono">pnpm everyapp secret set</span>,
                  or unset it first.
                </AlertDescription>
              </Alert>
            ) : null}

            <RedirectUriSection
              redirectUri={provider.redirectUri}
              console={provider.console}
              providerName={provider.name}
            />
            <ProviderHosts hosts={provider.hosts} what="connected accounts" />

            <form.AppField name="clientId">
              {(field) => (
                <field.TextField
                  label="Client ID"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="clientSecret">
              {(field) => (
                <field.TextField
                  label="Client secret"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                />
              )}
            </form.AppField>

            {error ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <form.SubmitButton>
                {replacing ? "Replace client" : "Save client"}
              </form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
