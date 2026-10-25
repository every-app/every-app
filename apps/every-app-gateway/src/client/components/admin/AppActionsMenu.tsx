import {
  Bot,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";

interface AppActionsMenuProps {
  appName: string;
  /** Present while the app needs setup: opens the setup dialog. */
  onSetup?: () => void;
  /** Absent for a shared app, whose access nobody manages. */
  onManageAccess?: () => void;
  onEdit: () => void;
  /** Deletes an app; removes an MCP app (the tombstone). */
  onDelete: () => void;
  /**
   * An MCP app's own actions: Use from your agent first, and Turn off or
   * Turn on (by its status) before Remove. Owners and admins turn it on
   * and off; only owners remove it, as only owners delete an app.
   */
  mcp?: {
    onUseMcp: () => void;
    /** Whether it is on (`active`) now. */
    on: boolean;
    onToggle: () => void;
  };
  isOwner: boolean;
}

/** The kebab menu at the end of an app row. Only owners can delete an app. */
export function AppActionsMenu({
  appName,
  onSetup,
  onManageAccess,
  onEdit,
  onDelete,
  mcp,
  isOwner,
}: AppActionsMenuProps) {
  const copy = MCP_APP_COPY.menu;
  return (
    <RowActionsMenu label={`Actions for ${appName}`}>
      {onSetup ? (
        <DropdownMenuItem onClick={onSetup}>
          <Wrench />
          Setup…
        </DropdownMenuItem>
      ) : null}
      {mcp ? (
        <DropdownMenuItem onClick={mcp.onUseMcp}>
          <Bot />
          {copy.useFromAgent}
        </DropdownMenuItem>
      ) : null}
      {onManageAccess ? (
        <DropdownMenuItem onClick={onManageAccess}>
          <Users />
          {copy.manageAccess}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={onEdit}>
        <Pencil />
        {mcp ? copy.edit : "Edit app"}
      </DropdownMenuItem>
      {mcp ? (
        <DropdownMenuItem onClick={mcp.onToggle}>
          {mcp.on ? <PowerOff /> : <Power />}
          {mcp.on ? copy.turnOff : copy.turnOn}
        </DropdownMenuItem>
      ) : null}
      {isOwner ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            {mcp ? copy.remove : "Delete app"}
          </DropdownMenuItem>
        </>
      ) : null}
    </RowActionsMenu>
  );
}
