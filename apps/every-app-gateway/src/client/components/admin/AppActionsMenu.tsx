import { Pencil, Trash2, Users } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";

interface AppActionsMenuProps {
  appName: string;
  onManageAccess: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isOwner: boolean;
}

/** The kebab menu at the end of an app row. Only owners can delete an app. */
export function AppActionsMenu({
  appName,
  onManageAccess,
  onEdit,
  onDelete,
  isOwner,
}: AppActionsMenuProps) {
  return (
    <RowActionsMenu label={`Actions for ${appName}`}>
      <DropdownMenuItem onClick={onManageAccess}>
        <Users />
        Manage access
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onEdit}>
        <Pencil />
        Edit app
      </DropdownMenuItem>
      {isOwner ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            Delete app
          </DropdownMenuItem>
        </>
      ) : null}
    </RowActionsMenu>
  );
}
