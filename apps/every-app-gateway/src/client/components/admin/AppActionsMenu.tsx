import { MoreVertical, Users, Pencil, Trash2 } from "lucide-react";

interface AppActionsMenuProps {
  onManageAccess: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function AppActionsMenu({
  onManageAccess,
  onEdit,
  onDelete,
}: AppActionsMenuProps) {
  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className="btn btn-ghost btn-sm btn-square">
        <MoreVertical className="w-4 h-4" />
      </button>
      <ul
        tabIndex={0}
        className="dropdown-content menu z-10 w-48 bg-base-100 rounded-box shadow-lg"
      >
        <li>
          <button onClick={onManageAccess}>
            <Users className="w-4 h-4" />
            Manage Access
          </button>
        </li>
        <li>
          <button onClick={onEdit}>
            <Pencil className="w-4 h-4" />
            Edit App
          </button>
        </li>
        <li>
          <button className="text-error" onClick={onDelete}>
            <Trash2 className="w-4 h-4" />
            Delete App
          </button>
        </li>
      </ul>
    </div>
  );
}
