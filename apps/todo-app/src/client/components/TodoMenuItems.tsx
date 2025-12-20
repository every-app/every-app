import { ComponentType } from "react";
import { Edit, Trash2 } from "lucide-react";
import { DeleteTodoConfirmation } from "@/client/components/DeleteTodoConfirmation";

interface MenuItemProps {
  onClick?: () => void;
  onSelect?: (e: Event) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

interface TodoMenuItemsProps {
  MenuItem: ComponentType<MenuItemProps>;
  isCompleted: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function TodoMenuItems({
  MenuItem,
  isCompleted,
  onEdit,
  onDelete,
}: TodoMenuItemsProps) {
  return (
    <>
      <MenuItem
        onClick={isCompleted ? undefined : onEdit}
        disabled={isCompleted}
        className="disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Edit className="h-4 w-4 mr-2" />
        Edit {isCompleted && "(Disabled)"}
      </MenuItem>
      <DeleteTodoConfirmation onConfirm={onDelete}>
        <MenuItem
          onSelect={(e) => e.preventDefault()}
          className="text-error focus:text-error focus:bg-error/10"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </MenuItem>
      </DeleteTodoConfirmation>
    </>
  );
}
