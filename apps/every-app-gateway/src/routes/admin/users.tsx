import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { adminUsersCollection } from "@/client/tanstack-db";
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
import { getServerErrorMessage } from "@/client/errors";
import { useSession } from "@/client/hooks/useSession";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { InviteUserModal } from "@/client/components/admin/InviteUserModal";
import { DeleteUserModal } from "@/client/components/admin/DeleteUserModal";
import { UsersTable } from "@/client/components/admin/UsersTable";
import { authClient } from "@/client/auth-client";

export const Route = createFileRoute("/admin/users")({
  component: UsersPage,
});

function UsersPage() {
  const { data: session } = useSession();
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isOwner = activeMemberRole?.role === "owner";
  const canManageInvitations =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const [revealedLink, setRevealedLink] = useState<RevealedLink | null>(null);

  const { data: users, isError } = useLiveQuery((q) =>
    q.from({ user: adminUsersCollection }),
  );

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
      });
    },
    onError: (err) => {
      toast.error(
        getServerErrorMessage(err, "Failed to create password reset link"),
      );
    },
  });

  const handleDeleteUser = (userId: string) => {
    adminUsersCollection.delete(userId);
    setShowDeleteModal(false);
    setSelectedUserId(null);
  };

  const sendPasswordResetEmailMutation = useMutation({
    mutationFn: (userId: string) =>
      sendPasswordResetEmail({ data: { userId } }),
    onSuccess: () => {
      toast.success("Password reset email sent");
    },
    onError: () => {
      toast.error("Failed to send password reset email");
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

  const handleDeactivate = (userId: string) => {
    const user = users?.find((candidate) => candidate.id === userId);
    const confirmed = window.confirm(
      `Deactivate ${user?.email ?? "this user"}? They are signed out everywhere, can no longer sign in, and their personal access tokens and deploy tokens are revoked.`,
    );
    if (!confirmed) return;

    deactivateMutation.mutate(userId);
  };

  const handleCancelInvitation = (invitationId: string) => {
    const invitation = users?.find(
      (user) => user.invitationId === invitationId,
    );
    const confirmed = window.confirm(
      `Cancel the invitation${invitation ? ` for ${invitation.email}` : ""}?`,
    );
    if (!confirmed) return;

    cancelInvitationMutation.mutate(invitationId);
  };

  const selectedUser = users?.find((u) => u.id === selectedUserId);

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-base-content/70 mt-1">
            Manage user accounts and invitations
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowInviteModal(true)}
        >
          <UserPlus className="w-4 h-4 mr-2" />
          Invite User
        </button>
      </div>

      {!emailConfigured && (
        <div className="alert alert-warning mb-4">
          <span>
            Email is not configured. Invitations and password resets give you a
            link to share instead.
          </span>
        </div>
      )}

      {isError && (
        <div className="alert alert-error">
          <span>Failed to load users. Please try again.</span>
        </div>
      )}

      {users && (
        <UsersTable
          users={users}
          emailConfigured={emailConfigured}
          onSendPasswordResetEmail={(userId) =>
            sendPasswordResetEmailMutation.mutate(userId)
          }
          onCreatePasswordResetLink={(userId) =>
            resetLinkMutation.mutate(userId)
          }
          onCopyInvitationLink={(invitationId) =>
            invitationLinkMutation.mutate(invitationId)
          }
          onDelete={(userId) => {
            setSelectedUserId(userId);
            setShowDeleteModal(true);
          }}
          onCancelInvitation={handleCancelInvitation}
          onChangeRole={(userId, role) =>
            changeRoleMutation.mutate({ userId, role })
          }
          onDeactivate={handleDeactivate}
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
      )}

      <InviteUserModal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        onSuccess={() => {
          setShowInviteModal(false);
          toast.success("Invitation email sent");
        }}
        onInvited={() => void adminUsersCollection.utils.refetch()}
      />

      <LinkRevealModal
        link={revealedLink}
        onClose={() => setRevealedLink(null)}
      />

      {isOwner && selectedUser && (
        <DeleteUserModal
          open={showDeleteModal}
          onClose={() => {
            setShowDeleteModal(false);
            setSelectedUserId(null);
          }}
          onConfirm={() => handleDeleteUser(selectedUserId!)}
          userName={selectedUser.name}
          userEmail={selectedUser.email}
        />
      )}
    </div>
  );
}
