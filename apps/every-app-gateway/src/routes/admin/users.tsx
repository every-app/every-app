import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { adminUsersCollection } from "@/client/tanstack-db";
import {
  cancelInvitation,
  sendPasswordResetEmail,
} from "@/serverFunctions/admin";
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
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isOwner = activeMemberRole?.role === "owner";
  const canManageInvitations =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { data: users, isError } = useLiveQuery((q) =>
    q.from({ user: adminUsersCollection }),
  );

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

      {isError && (
        <div className="alert alert-error">
          <span>Failed to load users. Please try again.</span>
        </div>
      )}

      {users && (
        <UsersTable
          users={users}
          onSendPasswordResetEmail={(userId) =>
            sendPasswordResetEmailMutation.mutate(userId)
          }
          onDeleteUser={(userId) => {
            setSelectedUserId(userId);
            setShowDeleteModal(true);
          }}
          onCancelInvitation={handleCancelInvitation}
          isSendingPasswordResetEmail={sendPasswordResetEmailMutation.isPending}
          isCancelingInvitation={cancelInvitationMutation.isPending}
          canManageInvitations={canManageInvitations}
          isOwner={isOwner}
        />
      )}

      <InviteUserModal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        onSuccess={async () => {
          setShowInviteModal(false);
          toast.success("Invitation email sent");
          await adminUsersCollection.utils.refetch();
        }}
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
