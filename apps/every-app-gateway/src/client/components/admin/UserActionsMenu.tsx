import { useState } from "react";
import {
  Crown,
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
  onChangeRole: (userId: string, role: "member" | "admin" | "owner") => void;
  onDeactivate: (userId: string) => void;
  onReactivate: (userId: string) => void;
  isPending: boolean;
}

interface UserActionsMenuProps extends UserActions {
  user: AdminUser;
  emailConfigured: boolean;
  canManageInvitations: boolean;
  isOwner: boolean;
  /** Owner memberships in the organization: the last one is never changed. */
  ownerCount: number;
  currentUserId: string | undefined;
}

/**
 * The row menu of the users table. Deactivating, canceling an invitation,
 * deleting and making someone an owner ask first; the callbacks run only
 * once the admin confirms.
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
          Invite link
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

type MemberConfirmation = "deactivate" | "delete" | "makeOwner";

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
  ownerCount,
  currentUserId,
}: UserActionsMenuProps) {
  const [confirming, setConfirming] = useState<MemberConfirmation | null>(null);

  // The server's rule (MembershipService): nobody manages themselves, an
  // admin manages members only (deleting them included), and an owner
  // manages everyone but the organization's last owner. Only an owner makes
  // or demotes an owner. The menu never offers what it refuses.
  if (user.id === currentUserId) {
    return null;
  }
  const targetIsOwner = user.role === "owner";
  const canManage = isOwner
    ? !(targetIsOwner && ownerCount <= 1)
    : user.role !== "admin" && !targetIsOwner;
  const subject = user.name || user.email;

  // A reset link hands the account to whoever holds it: never for an owner.
  const showResetEmail =
    canManage && !targetIsOwner && !user.banned && emailConfigured;
  const showResetLink = canManage && !targetIsOwner && !user.banned;
  const showRoleChange = canManage && !user.banned;
  const showMakeOwner = showRoleChange && isOwner && !targetIsOwner;
  const showReactivate = canManage && !!user.banned;
  const showDeactivate = canManage && !user.banned;
  const showDelete = canManage;

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
            Password reset link
          </DropdownMenuItem>
        ) : null}
        {showRoleChange && user.role !== "admin" ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onChangeRole(user.id, "admin")}
          >
            <ShieldCheck />
            Change role to admin
          </DropdownMenuItem>
        ) : null}
        {showRoleChange && user.role !== "member" ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onChangeRole(user.id, "member")}
          >
            <ShieldOff />
            Change role to member
          </DropdownMenuItem>
        ) : null}
        {showMakeOwner ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => setConfirming("makeOwner")}
          >
            <Crown />
            Make owner
          </DropdownMenuItem>
        ) : null}
        {showReactivate ? (
          <DropdownMenuItem
            disabled={isPending}
            onClick={() => onReactivate(user.id)}
          >
            <UserCheck />
            Reactivate user
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
            Deactivate user
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

      {confirming === "makeOwner" ? (
        <ConfirmDialog
          title={`Make ${subject} an owner?`}
          confirmLabel="Make owner"
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            onChangeRole(user.id, "owner");
          }}
        >
          Owners can do everything you can, including changing your role.
        </ConfirmDialog>
      ) : null}

      {confirming === "deactivate" ? (
        <ConfirmDialog
          title={`Deactivate ${subject}?`}
          confirmLabel="Deactivate"
          destructive
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            onDeactivate(user.id);
          }}
        >
          Signs them out everywhere, blocks sign-in and revokes their tokens.
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
