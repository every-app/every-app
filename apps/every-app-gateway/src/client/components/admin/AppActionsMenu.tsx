import { Pencil, Power, Trash2, Users, Wrench } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";

interface AppActionsMenuProps {
  appName: string;
  /** Present while the app needs setup: opens the setup dialog. */
  onSetup?: () => void;
  /** Absent for a shared app, whose access nobody manages. */
  onManageAccess?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** "Turn off" for an MCP app, which `onDelete` turns off rather than deletes. */
  deleteLabel?: string;
  isOwner: boolean;
}

/** The kebab menu at the end of an app row. Only owners can delete an app. */
export function AppActionsMenu({
  appName,
  onSetup,
  onManageAccess,
  onEdit,
  onDelete,
  deleteLabel = "Delete app",
  isOwner,
}: AppActionsMenuProps) {
  return (
    <RowActionsMenu label={`Actions for ${appName}`}>
      {onSetup ? (
        <DropdownMenuItem onClick={onSetup}>
          <Wrench />
          Setup…
        </DropdownMenuItem>
      ) : null}
      {onManageAccess ? (
        <DropdownMenuItem onClick={onManageAccess}>
          <Users />
          Manage access
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={onEdit}>
        <Pencil />
        Edit app
      </DropdownMenuItem>
      {isOwner ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            {deleteLabel === "Delete app" ? <Trash2 /> : <Power />}
            {deleteLabel}
          </DropdownMenuItem>
        </>
      ) : null}
    </RowActionsMenu>
  );
}
