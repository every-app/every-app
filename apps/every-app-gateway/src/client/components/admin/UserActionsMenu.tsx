import { MoreVertical, Key, Trash2 } from "lucide-react";
import type { AdminUser } from "@/types/admin-user";

interface UserActionsMenuProps {
  user: AdminUser;
  onSendPasswordResetEmail: (userId: string) => void;
  onDelete: (userId: string) => void;
  isSendingPasswordResetEmail: boolean;
}

export function UserActionsMenu({
  user,
  onSendPasswordResetEmail,
  onDelete,
  isSendingPasswordResetEmail,
}: UserActionsMenuProps) {
  if (user.role === "owner" || user.status === "pending") {
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
        <li>
          <button className="text-error" onClick={() => onDelete(user.id)}>
            <Trash2 className="w-4 h-4" />
            Delete User
          </button>
        </li>
      </ul>
    </div>
  );
}
