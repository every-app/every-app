import { MoreVertical, Key, Trash2, XCircle } from "lucide-react";
import type { AdminUser } from "@/types/admin-user";

interface UserActionsMenuProps {
  user: AdminUser;
  onSendPasswordResetEmail: (userId: string) => void;
  onDelete: (userId: string) => void;
  onCancelInvitation: (invitationId: string) => void;
  isSendingPasswordResetEmail: boolean;
  isCancelingInvitation: boolean;
  canManageInvitations: boolean;
  isOwner: boolean;
}

export function UserActionsMenu({
  user,
  onSendPasswordResetEmail,
  onDelete,
  onCancelInvitation,
  isSendingPasswordResetEmail,
  isCancelingInvitation,
  canManageInvitations,
  isOwner,
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
              className="text-error"
              onClick={() => onCancelInvitation(invitationId)}
              disabled={isCancelingInvitation}
            >
              <XCircle className="w-4 h-4" />
              Cancel Invitation
            </button>
          </li>
        </ul>
      </div>
    );
  }

  if (user.role === "owner") {
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
            onClick={() => onSendPasswordResetEmail(user.id)}
            disabled={isSendingPasswordResetEmail}
          >
            <Key className="w-4 h-4" />
            Send Password Reset Email
          </button>
        </li>
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
