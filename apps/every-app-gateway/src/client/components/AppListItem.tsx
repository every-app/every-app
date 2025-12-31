import { useState } from "react";
import { MoreVertical, Code } from "lucide-react";
import type { UserApp } from "@/types/user-app";

interface AppListItemProps {
  app: UserApp;
  onNavigate: () => void;
  onNavigateDev: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function AppListItem({
  app,
  onNavigate,
  onNavigateDev,
  onEdit,
  onDelete,
}: AppListItemProps) {
  const [isInteractingWithControls, setIsInteractingWithControls] =
    useState(false);

  return (
    <li
      className={`border border-base-content/20 rounded-lg bg-base-100 transition-all cursor-pointer ${
        !isInteractingWithControls
          ? "hover:bg-base-200 hover:border-base-400 hover:shadow-md"
          : ""
      }`}
      onClick={onNavigate}
    >
      <div className="flex items-center justify-between p-4">
        <div className="flex-1">
          <div className="font-medium">{app.name}</div>
          <div className="text-sm text-base-content/70">{app.description}</div>
        </div>
        <div
          className="flex items-center gap-2"
          onMouseEnter={() => setIsInteractingWithControls(true)}
          onMouseLeave={() => setIsInteractingWithControls(false)}
        >
          {app.devUrl && (
            <button
              className="btn btn-sm btn-ghost gap-1 hidden sm:flex"
              onClick={(e) => {
                e.stopPropagation();
                onNavigateDev();
              }}
            >
              <Code className="w-3 h-3" />
              Dev
            </button>
          )}
          <div
            className="dropdown dropdown-end relative z-10 hidden sm:block"
            onClick={(e) => e.stopPropagation()}
          >
            <button tabIndex={0} className="btn btn-ghost btn-sm btn-square">
              <MoreVertical className="w-4 h-4" />
            </button>
            <ul tabIndex={0} className="dropdown-content menu z-1 w-52">
              <li>
                <button onClick={onEdit}>Edit</button>
              </li>
              <li>
                <button className="text-error" onClick={onDelete}>
                  Delete
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </li>
  );
}
