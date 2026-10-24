import { AppWindow, Pencil, Trash2, Users } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";

interface GroupActionsMenuProps {
  groupName: string;
  onManageMembers: () => void;
  onManageApps: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** The kebab menu at the end of a group row. */
export function GroupActionsMenu({
  groupName,
  onManageMembers,
  onManageApps,
  onEdit,
  onDelete,
}: GroupActionsMenuProps) {
  return (
    <RowActionsMenu label={`Actions for ${groupName}`}>
      <DropdownMenuItem onClick={onManageMembers}>
        <Users />
        Manage members
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onManageApps}>
        <AppWindow />
        Manage apps
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onEdit}>
        <Pencil />
        Edit group
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        Delete group
      </DropdownMenuItem>
    </RowActionsMenu>
  );
}
