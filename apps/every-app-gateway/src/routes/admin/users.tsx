import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { adminUsersCollection } from "@/client/tanstack-db";
import {
  regenerateInviteLink,
  createPasswordResetLink,
} from "@/serverFunctions/admin";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { InviteUserModal } from "@/client/components/admin/InviteUserModal";
import { LinkDisplayModal } from "@/client/components/admin/LinkDisplayModal";
import { DeleteUserModal } from "@/client/components/admin/DeleteUserModal";
import { UsersTable } from "@/client/components/admin/UsersTable";

export const Route = createFileRoute("/admin/users")({
  component: UsersPage,
});

function UsersPage() {
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<"invite" | "reset">("invite");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { data: users, isError } = useLiveQuery((q) =>
    q.from({ user: adminUsersCollection }),
  );

  const handleDeleteUser = (userId: string) => {
    adminUsersCollection.delete(userId);
    setShowDeleteModal(false);
    setSelectedUserId(null);
  };

  const regenerateInviteMutation = useMutation({
    mutationFn: (userId: string) => regenerateInviteLink({ data: { userId } }),
    onSuccess: (data) => {
      setGeneratedLink(data.inviteUrl);
      setLinkType("invite");
      setShowLinkModal(true);
    },
    onError: () => {
      toast.error("Failed to regenerate invite link");
    },
  });

  const createResetLinkMutation = useMutation({
    mutationFn: (userId: string) =>
      createPasswordResetLink({ data: { userId } }),
    onSuccess: (data) => {
      setGeneratedLink(data.resetUrl);
      setLinkType("reset");
      setShowLinkModal(true);
    },
    onError: () => {
      toast.error("Failed to generate password reset link");
    },
  });

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
          onRegenerateInvite={(userId) =>
            regenerateInviteMutation.mutate(userId)
          }
          onCreateResetLink={(userId) => createResetLinkMutation.mutate(userId)}
          onDeleteUser={(userId) => {
            setSelectedUserId(userId);
            setShowDeleteModal(true);
          }}
          isRegeneratingInvite={regenerateInviteMutation.isPending}
          isCreatingResetLink={createResetLinkMutation.isPending}
        />
      )}

      <InviteUserModal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        onSuccess={async (inviteUrl) => {
          setShowInviteModal(false);
          setGeneratedLink(inviteUrl);
          setLinkType("invite");
          setShowLinkModal(true);
          await adminUsersCollection.utils.refetch();
        }}
      />

      <LinkDisplayModal
        open={showLinkModal}
        onClose={() => {
          setShowLinkModal(false);
          setGeneratedLink(null);
        }}
        link={generatedLink}
        type={linkType}
      />

      {selectedUser && (
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
