import { useState } from "react";
import { MoreVertical, Code } from "lucide-react";
import type { UserApp } from "@/types/user-app";

interface AppListItemProps {
  app: UserApp;
  onNavigate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function AppListItem({
  app,
  onNavigate,
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

interface DevAppListItemProps {
  app: UserApp;
  onNavigate: () => void;
}

export function DevAppListItem({ app, onNavigate }: DevAppListItemProps) {
  return (
    <li
      className="ml-6 border-l-2 border-primary rounded-r-lg bg-base-100 border-y border-r border-y-base-content/20 border-r-base-content/20 transition-all cursor-pointer hover:bg-base-200 hover:border-y-base-400 hover:border-r-base-400 hover:shadow-md"
      onClick={onNavigate}
    >
      <div className="flex items-center justify-between p-3 pl-4">
        <div className="flex items-center gap-3 flex-1">
          <Code className="w-4 h-4 text-primary" />
          <div>
            <div className="font-medium text-sm">Dev</div>
            <div className="text-xs text-base-content/50 truncate max-w-[200px] sm:max-w-none">
              {app.devUrl}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
