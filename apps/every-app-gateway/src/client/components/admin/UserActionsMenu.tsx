import { useState } from "react";
import {
  Key,
  Link as LinkIcon,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
  XCircle,
} from "lucide-react";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";
import type { AdminUser } from "@/types/admin-user";
import { DeleteUserModal } from "./DeleteUserModal";

export interface UserActions {
  onSendPasswordResetEmail: (userId: string) => void;
  onCreatePasswordResetLink: (userId: string) => void;
  onDelete: (userId: string) => void;
  onCopyInvitationLink: (invitationId: string) => void;
  onCancelInvitation: (invitationId: string) => void;
  onChangeRole: (userId: string, role: "member" | "admin") => void;
  onDeactivate: (userId: string) => void;
  onReactivate: (userId: string) => void;
  isPending: boolean;
}

interface UserActionsMenuProps extends UserActions {
  user: AdminUser;
  emailConfigured: boolean;
  canManageInvitations: boolean;
  isOwner: boolean;
  currentUserId: string | undefined;
}

/**
 * The row menu of the users table. Deactivating, canceling an invitation and
 * deleting ask first; the callbacks run only once the admin confirms.
 */
export function UserActionsMenu(props: UserActionsMenuProps) {
  return props.user.status === "pending" ? (
    <InvitationActionsMenu {...props} />
  ) : (
    <MemberActionsMenu {...props} />
  );
}

function InvitationActionsMenu({
  user,
  onCopyInvitationLink,
  onCancelInvitation,
  isPending,
  canManageInvitations,
}: UserActionsMenuProps) {
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);

  const invitationId = user.invitationId;
  if (!canManageInvitations || !invitationId) {
    return null;
  }

  return (
    <>
      <RowActionsMenu label={`Actions for the invitation to ${user.email}`}>
        <DropdownMenuItem
          disabled={isPending}
          onClick={() => onCopyInvitationLink(invitationId)}
        >
          <LinkIcon />
          Copy invite link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={isPending}
          onClick={() => setIsConfirmingCancel(true)}
        >
          <XCircle />
          Cancel invitation
        </DropdownMenuItem>
      </RowActionsMenu>
      {isConfirmingCancel ? (
        <ConfirmDialog
          title={`Cancel the invitation for ${user.email}?`}
          confirmLabel="Cancel invitation"
          cancelLabel="Keep invitation"
          destructive
          onClose={() => setIsConfirmingCancel(false)}
          onConfirm={() => {
            setIsConfirmingCancel(false);
            onCancelInvitation(invitationId);
          }}
        >
          Its invite link stops working.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

type MemberConfirmation = "deactivate" | "delete";

function MemberActionsMenu({
  user,
  emailConfigured,
  onSendPasswordResetEmail,
  onCreatePasswordResetLink,
  onDelete,
  onChangeRole,
  onDeactivate,
  onReactivate,
  isPending,
  isOwner,
  currentUserId,
}: UserActionsMenuProps) {
  const [confirming, setConfirming] = useState<MemberConfirmation | null>(null);

  // Owners are never managed here, nobody manages themselves, and only an
  // owner manages an admin (the server enforces the same rules).
  if (user.role === "owner" || user.id === currentUserId) {
    return null;
  }
  const canManage = isOwner || user.role !== "admin";

  const showResetEmail = !user.banned && emailConfigured;
  const showResetLink = !user.banned && canManage;
  const showRoleChange = canManage && !user.banned;
  const showReactivate = canManage && !!user.banned;
  const showDeactivate = canManage && !user.banned;
  const showDelete = isOwner;

  const hasSafeItems =
    showResetEmail || showResetLink || showRoleChange || showReactivate;
  const hasDestructiveItems = showDeactivate || showDelete;
  // A deactivated user an admin may not manage has nothing to offer.
  if (!hasSafeItems && !hasDestructiveItems) {
    return null;
  }

  return (
    <>
      <RowActionsMenu label={`Actions for ${user.email}`}>
        {showResetEmail ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onSendPasswordResetEmail(user.id)}
          >
            <Key />
            Send password reset email
          </DropdownMenuItem>
        ) : null}
        {showResetLink ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onCreatePasswordResetLink(user.id)}
          >
            <LinkIcon />
            Generate password reset link
          </DropdownMenuItem>
        ) : null}
        {showRoleChange ? (
          user.role === "admin" ? (
            <DropdownMenuItem
              disabled={isPending}
              onClick={() => onChangeRole(user.id, "member")}
            >
              <ShieldOff />
              Change role to member
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isPending}
              onClick={() => onChangeRole(user.id, "admin")}
            >
              <ShieldCheck />
              Change role to admin
            </DropdownMenuItem>
          )
        ) : null}
        {showReactivate ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onReactivate(user.id)}
          >
            <UserCheck />
            Reactivate
          </DropdownMenuItem>
        ) : null}
        {hasSafeItems && hasDestructiveItems ? <DropdownMenuSeparator /> : null}
        {showDeactivate ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={isPending}
            onClick={() => setConfirming("deactivate")}
          >
            <UserX />
            Deactivate
          </DropdownMenuItem>
        ) : null}
        {showDelete ? (
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirming("delete")}
          >
            <Trash2 />
            Delete user
          </DropdownMenuItem>
        ) : null}
      </RowActionsMenu>

      {confirming === "deactivate" ? (
        <ConfirmDialog
          title={`Deactivate ${user.email}?`}
          confirmLabel="Deactivate"
          destructive
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            onDeactivate(user.id);
          }}
        >
          They are signed out everywhere, can no longer sign in, and their
          personal access tokens are revoked.
        </ConfirmDialog>
      ) : null}

      {confirming === "delete" ? (
        <DeleteUserModal
          userName={user.name}
          userEmail={user.email}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            onDelete(user.id);
          }}
        />
      ) : null}
    </>
  );
}
