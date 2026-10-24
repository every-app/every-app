import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MailWarning, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { adminUsersCollection, useQueryFailed } from "@/client/tanstack-db";
import {
  cancelInvitation,
  createPasswordResetLink,
  deactivateUser,
  getEmailStatus,
  getInvitationLink,
  reactivateUser,
  sendPasswordResetEmail,
  updateMemberRole,
} from "@/serverFunctions/admin";
import {
  LinkRevealModal,
  type RevealedLink,
} from "@/client/components/admin/LinkRevealModal";
import { InviteUserModal } from "@/client/components/admin/InviteUserModal";
import { UsersTable } from "@/client/components/admin/UsersTable";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { getServerErrorMessage } from "@/client/errors";
import { useSession } from "@/client/hooks/useSession";
import { authClient } from "@/client/auth-client";

export const Route = createFileRoute("/_app/admin/users")({
  component: UsersPage,
});

function UsersPage() {
  const { data: session } = useSession();
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isOwner = activeMemberRole?.role === "owner";
  const canManageInvitations =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [revealedLink, setRevealedLink] = useState<RevealedLink | null>(null);

  const {
    data: users,
    isLoading,
    isError: isCollectionError,
  } = useLiveQuery((q) => q.from({ user: adminUsersCollection }));
  // A failed fetch leaves the collection "ready" and empty: ask the query.
  const isError = isCollectionError || useQueryFailed(["admin", "users"]);

  const emailStatus = useQuery({
    queryKey: ["admin", "emailStatus"],
    queryFn: () => getEmailStatus(),
  });
  const emailConfigured = emailStatus.data?.configured ?? true;

  const invitationLinkMutation = useMutation({
    mutationFn: (invitationId: string) =>
      getInvitationLink({ data: { invitationId } }),
    onSuccess: (result) => {
      setRevealedLink({
        title: "Invite link",
        description: `Send this link to ${result.email}. They sign up or sign in with that email to join.`,
        url: result.inviteUrl,
        expiresAt: result.expiresAt,
        restriction: `Only ${result.email} can use it.`,
      });
    },
    onError: (err) => {
      toast.error(getServerErrorMessage(err, "Failed to get invite link"));
    },
  });

  const resetLinkMutation = useMutation({
    mutationFn: (userId: string) =>
      createPasswordResetLink({ data: { userId } }),
    onSuccess: (result) => {
      setRevealedLink({
        title: "Password reset link",
        description: `Send this link to ${result.email}. It lets them choose a new password.`,
        url: result.url,
        expiresAt: result.expiresAt,
        restriction:
          "Anyone with it can set the password, so share it privately.",
      });
    },
    onError: (err) => {
      toast.error(
        getServerErrorMessage(err, "Failed to create password reset link"),
      );
    },
  });

  // UserActionsMenu confirms first. The collection deletes optimistically.
  const handleDeleteUser = (userId: string) => {
    adminUsersCollection.delete(userId);
  };

  const sendPasswordResetEmailMutation = useMutation({
    mutationFn: (userId: string) =>
      sendPasswordResetEmail({ data: { userId } }),
    onSuccess: () => {
      toast.success("Password reset email sent");
    },
    onError: (err) => {
      toast.error(
        getServerErrorMessage(err, "Failed to send password reset email"),
      );
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: (invitationId: string) =>
      cancelInvitation({ data: { invitationId } }),
    onSuccess: async () => {
      await adminUsersCollection.utils.refetch();
      toast.success("Invitation canceled");
    },
    onError: () => {
      toast.error("Failed to cancel invitation");
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: (input: { userId: string; role: "member" | "admin" }) =>
      updateMemberRole({ data: input }),
    onSuccess: async (_result, input) => {
      await adminUsersCollection.utils.refetch();
      toast.success(`Role changed to ${input.role}`);
    },
    onError: (err) => {
      toast.error(getServerErrorMessage(err, "Failed to change role"));
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (userId: string) => deactivateUser({ data: { userId } }),
    onSuccess: async () => {
      await adminUsersCollection.utils.refetch();
      toast.success("User deactivated");
    },
    onError: (err) => {
      toast.error(getServerErrorMessage(err, "Failed to deactivate user"));
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (userId: string) => reactivateUser({ data: { userId } }),
    onSuccess: async () => {
      await adminUsersCollection.utils.refetch();
      toast.success("User reactivated");
    },
    onError: (err) => {
      toast.error(getServerErrorMessage(err, "Failed to reactivate user"));
    },
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Users"
        action={
          <Button onClick={() => setShowInviteModal(true)}>
            <UserPlus data-icon="inline-start" />
            Invite user
          </Button>
        }
      />

      {!emailConfigured ? (
        <Alert variant="warning">
          <MailWarning />
          <AlertDescription className="text-foreground">
            Email is not configured. Invitations and password resets give you a
            link to share instead.
          </AlertDescription>
        </Alert>
      ) : null}

      <UsersTable
        users={users}
        isLoading={isLoading && users.length === 0}
        error={
          isError ? (
            <ErrorState
              message="Couldn't load users."
              onRetry={() => void adminUsersCollection.utils.refetch()}
            />
          ) : undefined
        }
        emailConfigured={emailConfigured}
        onSendPasswordResetEmail={(userId) =>
          sendPasswordResetEmailMutation.mutate(userId)
        }
        onCreatePasswordResetLink={(userId) => resetLinkMutation.mutate(userId)}
        onCopyInvitationLink={(invitationId) =>
          invitationLinkMutation.mutate(invitationId)
        }
        onDelete={handleDeleteUser}
        onCancelInvitation={(invitationId) =>
          cancelInvitationMutation.mutate(invitationId)
        }
        onChangeRole={(userId, role) =>
          changeRoleMutation.mutate({ userId, role })
        }
        onDeactivate={(userId) => deactivateMutation.mutate(userId)}
        onReactivate={(userId) => reactivateMutation.mutate(userId)}
        isPending={
          sendPasswordResetEmailMutation.isPending ||
          resetLinkMutation.isPending ||
          invitationLinkMutation.isPending ||
          cancelInvitationMutation.isPending ||
          changeRoleMutation.isPending ||
          deactivateMutation.isPending ||
          reactivateMutation.isPending
        }
        canManageInvitations={canManageInvitations}
        isOwner={isOwner}
        currentUserId={session?.user.id}
      />

      {showInviteModal ? (
        <InviteUserModal
          onClose={() => setShowInviteModal(false)}
          onSuccess={() => {
            setShowInviteModal(false);
            toast.success("Invitation email sent");
          }}
          onInvited={() => void adminUsersCollection.utils.refetch()}
        />
      ) : null}

      <LinkRevealModal
        link={revealedLink}
        onClose={() => setRevealedLink(null)}
      />
    </div>
  );
}
