import { useState } from "react";
import { Info, Search } from "lucide-react";
import type { AppWithAccessCount } from "@/types/app";
import { AppActionsMenu } from "./AppActionsMenu";

interface AppsTableProps {
  apps: AppWithAccessCount[];
  onManageAccess: (appId: string) => void;
  onEdit: (app: AppWithAccessCount) => void;
  onDelete: (app: AppWithAccessCount) => void;
  isOwner: boolean;
}

export function AppsTable({
  apps,
  onManageAccess,
  onEdit,
  onDelete,
  isOwner,
}: AppsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredApps = apps.filter(
    (app) =>
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.appId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  if (apps.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-base-content/70">
          No apps yet. Add your first app to get started!
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Search input */}
      {apps.length > 3 && (
        <div className="mb-4">
          <label className="input w-full max-w-xs">
            <Search className="w-4 h-4 opacity-50" />
            <input
              type="text"
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th className="w-full">App</th>
            <th>New Users</th>
            <th>Access</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredApps.map((app) => (
            <tr key={app.id}>
              <td className="w-full">
                <div className="flex items-center gap-2">
                  <div className="font-medium">{app.name}</div>
                  {app.description && (
                    <div
                      className="tooltip tooltip-right"
                      data-tip={app.description}
                    >
                      <Info className="w-4 h-4 text-base-content/40 cursor-help" />
                    </div>
                  )}
                </div>
                <div className="text-xs text-base-content/50">{app.appId}</div>
              </td>
              <td className="whitespace-nowrap">
                {app.isDefault ? (
                  <span className="badge badge-soft badge-success badge-sm rounded-full">
                    Auto-grant
                  </span>
                ) : (
                  <span className="badge badge-ghost badge-sm rounded-full">
                    Manual
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap">
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => onManageAccess(app.id)}
                >
                  {app.accessCount} {app.accessCount === 1 ? "user" : "users"}
                </button>
              </td>
              <td>
                <AppActionsMenu
                  onManageAccess={() => onManageAccess(app.id)}
                  onEdit={() => onEdit(app)}
                  onDelete={() => onDelete(app)}
                  isOwner={isOwner}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* No results message */}
      {filteredApps.length === 0 && searchQuery && (
        <div className="text-center py-8">
          <p className="text-base-content/70">No apps match "{searchQuery}"</p>
        </div>
      )}
    </div>
  );
}
