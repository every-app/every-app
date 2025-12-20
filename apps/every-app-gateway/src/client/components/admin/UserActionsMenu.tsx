import { MoreVertical, RefreshCw, Key, Trash2 } from "lucide-react";
import type { AdminUser } from "@/types/admin-user";

interface UserActionsMenuProps {
  user: AdminUser;
  onRegenerateInvite: (userId: string) => void;
  onCreateResetLink: (userId: string) => void;
  onDelete: (userId: string) => void;
  isRegeneratingInvite: boolean;
  isCreatingResetLink: boolean;
}

export function UserActionsMenu({
  user,
  onRegenerateInvite,
  onCreateResetLink,
  onDelete,
  isRegeneratingInvite,
  isCreatingResetLink,
}: UserActionsMenuProps) {
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
        {user.status === "pending" ? (
          <li>
            <button
              onClick={() => onRegenerateInvite(user.id)}
              disabled={isRegeneratingInvite}
            >
              <RefreshCw className="w-4 h-4" />
              Regenerate Invite Link
            </button>
          </li>
        ) : (
          <li>
            <button
              onClick={() => onCreateResetLink(user.id)}
              disabled={isCreatingResetLink}
            >
              <Key className="w-4 h-4" />
              Generate Password Reset
            </button>
          </li>
        )}
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
