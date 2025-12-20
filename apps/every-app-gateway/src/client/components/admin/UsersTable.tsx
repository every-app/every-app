import type { AdminUser } from "@/types/admin-user";
import { UserActionsMenu } from "./UserActionsMenu";

interface UsersTableProps {
  users: AdminUser[];
  onRegenerateInvite: (userId: string) => void;
  onCreateResetLink: (userId: string) => void;
  onDeleteUser: (userId: string) => void;
  isRegeneratingInvite: boolean;
  isCreatingResetLink: boolean;
}

export function UsersTable({
  users,
  onRegenerateInvite,
  onCreateResetLink,
  onDeleteUser,
  isRegeneratingInvite,
  isCreatingResetLink,
}: UsersTableProps) {
  if (users.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-base-content/70">
          No users yet. Invite your first user to get started!
        </p>
      </div>
    );
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Role</th>
          <th>Status</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <tr key={user.id}>
            <td className="font-medium">{user.email}</td>
            <td className="capitalize">{user.role || "member"}</td>
            <td>
              <span
                className={`badge rounded w-full capitalize ${
                  user.status === "active" ? "badge-neutral" : "badge-warning"
                }`}
              >
                {user.status || "active"}
              </span>
            </td>
            <td className="text-base-content/70">
              {user.createdAt
                ? new Date(user.createdAt).toLocaleDateString()
                : "-"}
            </td>
            <td>
              <UserActionsMenu
                user={user}
                onRegenerateInvite={onRegenerateInvite}
                onCreateResetLink={onCreateResetLink}
                onDelete={onDeleteUser}
                isRegeneratingInvite={isRegeneratingInvite}
                isCreatingResetLink={isCreatingResetLink}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
