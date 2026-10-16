import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { z } from "zod";
import { inviteMember } from "@/serverFunctions/admin";
import { getServerErrorMessage } from "@/client/errors";
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
import { LinkRevealContent } from "./LinkRevealModal";

type Role = "member" | "admin";
type InviteResult = Awaited<ReturnType<typeof inviteMember>>;

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  role: z.enum(["member", "admin"]),
});

const ROLE_ITEMS: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

const ROLE_HINTS: Record<Role, string> = {
  member: "Opens the apps they are given.",
  admin: "Also manages users and apps.",
};

interface InviteUserModalProps {
  onClose: () => void;
  /** Called after an invitation is created and emailed. */
  onSuccess: () => void;
  /** Called after an invitation is created, emailed or not. */
  onInvited: () => void;
}

/** Invite someone to the organization. Render it only while it is open. */
export function InviteUserModal({
  onClose,
  onSuccess,
  onInvited,
}: InviteUserModalProps) {
  const [error, setError] = useState<string | null>(null);
  // Set when the invitation was created but not emailed: show its link.
  const [unsent, setUnsent] = useState<InviteResult | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: Role }) => inviteMember({ data }),
    onSuccess: (result) => {
      onInvited();
      if (result.emailSent) {
        onSuccess();
      } else {
        setUnsent(result);
      }
    },
    onError: (err) => {
      setError(getServerErrorMessage(err, "Failed to create invite"));
    },
  });

  const form = useAppForm({
    defaultValues: { email: "", role: "member" as Role },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: inviteSchema },
    // The mutation's onError shows a failure, so the rejection is not handled
    // here.
    onSubmit: ({ value }) => {
      setError(null);
      return inviteMutation.mutateAsync({
        email: value.email.trim(),
        role: value.role,
      });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inviteMutation.isPending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // A minmax(0, 1fr) track, so a long invite link scrolls in its box.
        className="grid-cols-1 sm:max-w-md"
      >
        {unsent ? (
          <LinkRevealContent
            title="Copy invite link"
            description={`The invitation for ${unsent.email} was created but not emailed.`}
            notice={
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription className="text-foreground">
                  {unsent.emailConfigured
                    ? "Sending the invitation email failed."
                    : "Email is not configured on this gateway."}{" "}
                  Send this link to {unsent.email} yourself.
                </AlertDescription>
              </Alert>
            }
            url={unsent.inviteUrl}
            footnote={
              <>
                Works once, until {new Date(unsent.expiresAt).toLocaleString()},
                and only for an account with this email address.
              </>
            }
            onDone={onClose}
          />
        ) : (
          <form.AppForm>
            <form.Form className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Invite user</DialogTitle>
                <DialogDescription>
                  They join this organization when they sign up or sign in with
                  this email address.
                </DialogDescription>
              </DialogHeader>
              <form.AppField name="email">
                {(field) => (
                  <field.TextField
                    label="Email"
                    type="email"
                    placeholder="user@example.com"
                    autoComplete="off"
                    required
                    autoFocus
                  />
                )}
              </form.AppField>
              <form.AppField name="role">
                {(field) => (
                  <field.SelectField
                    label="Role"
                    items={ROLE_ITEMS}
                    description={ROLE_HINTS[field.state.value]}
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
                <Button
                  variant="ghost"
                  onClick={onClose}
                  disabled={inviteMutation.isPending}
                >
                  Cancel
                </Button>
                <form.SubmitButton>Invite</form.SubmitButton>
              </DialogFooter>
            </form.Form>
          </form.AppForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
