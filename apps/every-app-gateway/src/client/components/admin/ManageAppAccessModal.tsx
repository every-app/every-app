import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, Minus } from "lucide-react";
import { Modal } from "../Modal";
import { useSession } from "@/client/hooks/useSession";
import { getAppAccessState, updateAppAccess } from "@/serverFunctions/apps";
import { adminAppsCollection } from "@/client/tanstack-db";
import type { AppWithAccessCount, UserAccessState } from "@/types/app";

interface ManageAppAccessModalProps {
  open: boolean;
  onClose: () => void;
  app: AppWithAccessCount | null;
}

export function ManageAppAccessModal({
  open,
  onClose,
  app,
}: ManageAppAccessModalProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    new Set(),
  );
  const [originalUserIds, setOriginalUserIds] = useState<Set<string>>(
    new Set(),
  );
  const [hasChanges, setHasChanges] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Fetch access state when modal opens
  const { data, isLoading } = useQuery({
    queryKey: ["app-access", app?.id],
    queryFn: () => getAppAccessState({ data: { id: app!.id } }),
    enabled: open && !!app,
  });

  // Initialize selected users when data loads
  useEffect(() => {
    if (data?.users) {
      const usersWithAccess = data.users
        .filter((u: UserAccessState) => u.hasAccess)
        .map((u: UserAccessState) => u.id);
      const accessSet = new Set(usersWithAccess);
      setSelectedUserIds(accessSet);
      setOriginalUserIds(new Set(usersWithAccess));
      setHasChanges(false);
    }
  }, [data]);

  const toggleUser = (userId: string) => {
    // Prevent toggling your own access
    if (userId === currentUserId) return;

    setSelectedUserIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }
      return newSet;
    });
    setHasChanges(true);
  };

  const handleGrantAll = () => {
    if (data?.users) {
      setSelectedUserIds(new Set(data.users.map((u: UserAccessState) => u.id)));
      setHasChanges(true);
    }
  };

  const handleRevokeAll = () => {
    // Keep current user selected when revoking all
    if (currentUserId) {
      setSelectedUserIds(new Set([currentUserId]));
    } else {
      setSelectedUserIds(new Set());
    }
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!app) return;

    const userIds = Array.from(selectedUserIds);

    setIsSaving(true);
    try {
      // Update access on server, then refetch to get accurate access count
      // Note: We don't use collection.update() here because accessCount is
      // a derived value from user_app_access table, not an app field
      await updateAppAccess({
        data: { appId: app.id, userIds },
      });
      await adminAppsCollection.utils.refetch();

      setHasChanges(false);
      setSearchQuery("");
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setHasChanges(false);
    setSearchQuery("");
    onClose();
  };

  const users = data?.users ?? [];
  const isPending = isSaving;

  // Filter users based on search query
  const filteredUsers = useMemo(() => {
    if (!searchQuery) return users;
    const query = searchQuery.toLowerCase();
    return users.filter(
      (user: UserAccessState) =>
        user.name.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query),
    );
  }, [users, searchQuery]);

  // Calculate what's changing
  const changes = useMemo(() => {
    const granting: string[] = [];
    const revoking: string[] = [];

    for (const userId of selectedUserIds) {
      if (!originalUserIds.has(userId)) {
        granting.push(userId);
      }
    }
    for (const userId of originalUserIds) {
      if (!selectedUserIds.has(userId)) {
        revoking.push(userId);
      }
    }

    return { granting, revoking };
  }, [selectedUserIds, originalUserIds]);

  // Determine if bulk actions would have any effect
  const canGrantAll = useMemo(() => {
    // Grant All is useful if at least one user doesn't have access originally
    return users.some((u: UserAccessState) => !originalUserIds.has(u.id));
  }, [users, originalUserIds]);

  const canRevokeAll = useMemo(() => {
    // Revoke All is useful if at least one user (other than current user) has access originally
    return users.some(
      (u: UserAccessState) =>
        originalUserIds.has(u.id) && u.id !== currentUserId,
    );
  }, [users, originalUserIds, currentUserId]);

  if (!open || !app) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Manage Access: ${app.name}`}
      description="Select which users can access this app"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!hasChanges || isPending}
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
        </>
      }
    >
      <div className="mt-4">
        {/* Search and bulk actions */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {users.length > 5 && (
            <label className="input input-sm flex-1 min-w-48">
              <Search className="w-4 h-4 opacity-50" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </label>
          )}
          {(canGrantAll || canRevokeAll) && (
            <div className="flex gap-2 ml-auto">
              {canGrantAll && (
                <button
                  type="button"
                  className="btn btn-sm btn-soft btn-success"
                  onClick={handleGrantAll}
                  disabled={isPending}
                >
                  Grant All
                </button>
              )}
              {canRevokeAll && (
                <button
                  type="button"
                  className="btn btn-sm btn-soft btn-error"
                  onClick={handleRevokeAll}
                  disabled={isPending}
                >
                  Revoke All
                </button>
              )}
            </div>
          )}
        </div>

        {/* User list */}
        {isLoading ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner loading-md"></span>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto border border-base-300 rounded-lg">
            {filteredUsers.length === 0 && searchQuery ? (
              <div className="text-center py-8">
                <p className="text-base-content/70 text-sm">
                  No users match "{searchQuery}"
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-base-300">
                {filteredUsers.map((user: UserAccessState) => {
                  const isCurrentUser = user.id === currentUserId;
                  const isSelected = selectedUserIds.has(user.id);
                  const hadAccess = originalUserIds.has(user.id);
                  const isGranting = isSelected && !hadAccess;
                  const isRevoking = !isSelected && hadAccess;
                  const displayName = user.name || user.email.split("@")[0];

                  return (
                    <li key={user.id}>
                      <label
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-base-200 transition-colors ${
                          isCurrentUser ? "cursor-not-allowed opacity-75" : ""
                        } ${isGranting ? "bg-success/10" : ""} ${isRevoking ? "bg-error/10" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm checkbox-primary"
                          checked={isSelected}
                          onChange={() => toggleUser(user.id)}
                          disabled={isPending || isCurrentUser}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">
                              {displayName}
                            </span>
                            {isCurrentUser && (
                              <span className="badge badge-sm rounded-full">
                                You
                              </span>
                            )}
                            {user.status && user.status !== "active" && (
                              <span className="badge badge-sm badge-warning">
                                {user.status}
                              </span>
                            )}
                          </div>
                          {user.name && (
                            <div className="text-xs text-base-content/60 truncate">
                              {user.email}
                            </div>
                          )}
                        </div>
                        {isGranting ? (
                          <span className="badge badge-sm badge-success gap-1 rounded-full">
                            <Plus className="w-3 h-3" />
                            Granting
                          </span>
                        ) : isRevoking ? (
                          <span className="badge badge-sm badge-error gap-1 rounded-full">
                            <Minus className="w-3 h-3" />
                            Revoking
                          </span>
                        ) : (
                          <span
                            className={`text-xs ${
                              isSelected
                                ? "text-base-content/60"
                                : "text-base-content/40"
                            }`}
                          >
                            {isSelected ? "Has access" : "No access"}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Summary */}
        <div className="mt-4 space-y-2">
          {hasChanges &&
            (changes.granting.length > 0 || changes.revoking.length > 0) && (
              <div className="flex flex-wrap gap-3 text-sm">
                {changes.granting.length > 0 && (
                  <span className="text-success">
                    +{changes.granting.length} gaining access
                  </span>
                )}
                {changes.revoking.length > 0 && (
                  <span className="text-error">
                    -{changes.revoking.length} losing access
                  </span>
                )}
              </div>
            )}
          <div className="flex items-center justify-between text-sm text-base-content/60">
            <span>
              {selectedUserIds.size} of {users.length} user
              {users.length !== 1 ? "s" : ""} will have access
            </span>
            {searchQuery && filteredUsers.length !== users.length && (
              <span className="text-xs">
                Showing {filteredUsers.length} of {users.length}
              </span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
