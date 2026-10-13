import {
  MoreVertical,
  Key,
  Link as LinkIcon,
  Trash2,
  XCircle,
  ShieldCheck,
  ShieldOff,
  UserX,
  UserCheck,
} from "lucide-react";
import type { AdminUser } from "@/types/admin-user";

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

export function UserActionsMenu({
  user,
  emailConfigured,
  onSendPasswordResetEmail,
  onCreatePasswordResetLink,
  onDelete,
  onCopyInvitationLink,
  onCancelInvitation,
  onChangeRole,
  onDeactivate,
  onReactivate,
  isPending,
  canManageInvitations,
  isOwner,
  currentUserId,
}: UserActionsMenuProps) {
  if (user.status === "pending") {
    const invitationId = user.invitationId;
    if (!canManageInvitations || !invitationId) {
      return null;
    }

    return (
      <div className="dropdown dropdown-end">
        <button tabIndex={0} className="btn btn-ghost btn-sm btn-square">
          <MoreVertical className="w-4 h-4" />
        </button>
        <ul
          tabIndex={0}
          className="dropdown-content menu z-10 w-56 bg-base-100 rounded-box shadow-lg"
        >
          <li>
            <button
              onClick={() => onCopyInvitationLink(invitationId)}
              disabled={isPending}
            >
              <LinkIcon className="w-4 h-4" />
              Copy Invite Link
            </button>
          </li>
          <li>
            <button
              className="text-error"
              onClick={() => onCancelInvitation(invitationId)}
              disabled={isPending}
            >
              <XCircle className="w-4 h-4" />
              Cancel Invitation
            </button>
          </li>
        </ul>
      </div>
    );
  }

  // Owners are never managed here, nobody manages themselves, and only an
  // owner manages an admin (the server enforces the same rules).
  if (user.role === "owner" || user.id === currentUserId) {
    return null;
  }
  const canManage = isOwner || user.role !== "admin";

  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className="btn btn-ghost btn-sm btn-square">
        <MoreVertical className="w-4 h-4" />
      </button>
      <ul
        tabIndex={0}
        className="dropdown-content menu z-10 w-60 bg-base-100 rounded-box shadow-lg"
      >
        {!user.banned && emailConfigured && (
          <li>
            <button
              onClick={() => onSendPasswordResetEmail(user.id)}
              disabled={isPending}
            >
              <Key className="w-4 h-4" />
              Send Password Reset Email
            </button>
          </li>
        )}
        {!user.banned && canManage && (
          <li>
            <button
              onClick={() => onCreatePasswordResetLink(user.id)}
              disabled={isPending}
            >
              <LinkIcon className="w-4 h-4" />
              Generate Password Reset Link
            </button>
          </li>
        )}
        {canManage && !user.banned && (
          <li>
            {user.role === "admin" ? (
              <button
                onClick={() => onChangeRole(user.id, "member")}
                disabled={isPending}
              >
                <ShieldOff className="w-4 h-4" />
                Change role to member
              </button>
            ) : (
              <button
                onClick={() => onChangeRole(user.id, "admin")}
                disabled={isPending}
              >
                <ShieldCheck className="w-4 h-4" />
                Change role to admin
              </button>
            )}
          </li>
        )}
        {canManage && (
          <li>
            {user.banned ? (
              <button
                onClick={() => onReactivate(user.id)}
                disabled={isPending}
              >
                <UserCheck className="w-4 h-4" />
                Reactivate
              </button>
            ) : (
              <button
                className="text-error"
                onClick={() => onDeactivate(user.id)}
                disabled={isPending}
              >
                <UserX className="w-4 h-4" />
                Deactivate
              </button>
            )}
          </li>
        )}
        {isOwner && (
          <li>
            <button className="text-error" onClick={() => onDelete(user.id)}>
              <Trash2 className="w-4 h-4" />
              Delete User
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
