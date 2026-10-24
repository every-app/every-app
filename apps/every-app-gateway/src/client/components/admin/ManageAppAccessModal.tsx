import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Minus, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { ErrorState } from "@/client/components/ErrorState";
import { ScrollBox } from "@/client/components/ScrollBox";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/client/components/ui/input-group";
import { Skeleton } from "@/client/components/ui/skeleton";
import { useSession } from "@/client/hooks/useSession";
import { getServerErrorMessage } from "@/client/errors";
import { getAppAccessState, updateAppAccess } from "@/serverFunctions/apps";
import { adminAppsCollection } from "@/client/tanstack-db";
import type { AppWithAccessCount, UserAccessState } from "@/types/app";

interface ManageAppAccessModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
}

/**
 * Picks who can open an app directly. Someone a group grants it to is shown
 * with the group's name; when that is their only grant the box is checked
 * and disabled, since only Admin -> Groups changes it, and when they hold
 * both, unchecking removes the direct grant while the group's keeps them
 * in. Saving sends the direct list alone and never touches what a group
 * grants. Render it only while it is open.
 */
export function ManageAppAccessModal({
  app,
  onClose,
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

  // Fetch access state when the dialog opens
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["app-access", app.id],
    queryFn: () => getAppAccessState({ data: { id: app.id } }),
  });

  // Initialize selected users when data loads: the direct grants.
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

  const users = useMemo(() => data?.users ?? [], [data]);
  /** Users a group grants the app: they keep it whatever the direct list says. */
  const viaGroup = useMemo(
    () =>
      new Set(
        users
          .filter((u: UserAccessState) => u.viaGroups.length)
          .map((u: UserAccessState) => u.id),
      ),
    [users],
  );
  /** Users whose only grant comes through a group: shown checked, not editable here. */
  const viaGroupOnly = useMemo(
    () =>
      new Set(
        users
          .filter((u: UserAccessState) => !u.hasAccess && u.viaGroups.length)
          .map((u: UserAccessState) => u.id),
      ),
    [users],
  );

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

  // A direct grant for everyone not already granted through a group.
  const handleGrantAll = () => {
    if (data?.users) {
      setSelectedUserIds(
        new Set(
          data.users
            .filter((u: UserAccessState) => !viaGroupOnly.has(u.id))
            .map((u: UserAccessState) => u.id),
        ),
      );
      setHasChanges(true);
    }
  };

  // Every direct grant but the current user's own, which can't be changed
  // here (and is never added: an admin let in by a group alone stays so).
  const handleRevokeAll = () => {
    setSelectedUserIds(
      currentUserId && originalUserIds.has(currentUserId)
        ? new Set([currentUserId])
        : new Set(),
    );
    setHasChanges(true);
  };

  const handleSave = async () => {
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

      toast.success("Access updated");
      onClose();
    } catch (err) {
      toast.error(getServerErrorMessage(err, "Failed to update access"));
    } finally {
      setIsSaving(false);
    }
  };

  // The search, with whoever could open the app when the dialog opened
  // first. The order follows the loaded state, not the checkboxes, so rows
  // never jump while toggling.
  const filteredUsers = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const matching = query
      ? users.filter(
          (user: UserAccessState) =>
            user.name.toLowerCase().includes(query) ||
            user.email.toLowerCase().includes(query),
        )
      : users;
    const hadAccess = (user: UserAccessState) =>
      user.hasAccess || user.viaGroups.length > 0;
    return [...matching].sort(
      (a, b) => Number(hadAccess(b)) - Number(hadAccess(a)),
    );
  }, [users, searchQuery]);

  // What's changing: who gains access, who loses it, and whose direct
  // grant goes while a group keeps them in.
  const changes = useMemo(() => {
    const granting: string[] = [];
    const revoking: string[] = [];
    const keptByGroup: string[] = [];

    for (const userId of selectedUserIds) {
      if (!originalUserIds.has(userId)) {
        granting.push(userId);
      }
    }
    for (const userId of originalUserIds) {
      if (!selectedUserIds.has(userId)) {
        (viaGroup.has(userId) ? keptByGroup : revoking).push(userId);
      }
    }

    return { granting, revoking, keptByGroup };
  }, [selectedUserIds, originalUserIds, viaGroup]);

  // Who opens the app once saved: the direct list, and everyone a group
  // grants it to; of those, how many through a group alone.
  const outcome = useMemo(() => {
    const withAccess = users.filter(
      (u: UserAccessState) => selectedUserIds.has(u.id) || viaGroup.has(u.id),
    );
    return {
      withAccess: withAccess.length,
      throughGroups: withAccess.filter((u) => !selectedUserIds.has(u.id))
        .length,
    };
  }, [users, selectedUserIds, viaGroup]);

  // Determine if bulk actions would have any effect
  const canGrantAll = useMemo(() => {
    // Grant All is useful if at least one user doesn't have access originally
    return users.some(
      (u: UserAccessState) =>
        !originalUserIds.has(u.id) && !viaGroupOnly.has(u.id),
    );
  }, [users, originalUserIds, viaGroupOnly]);

  const canRevokeAll = useMemo(() => {
    // Revoke All is useful if at least one user (other than current user) has access originally
    return users.some(
      (u: UserAccessState) =>
        originalUserIds.has(u.id) && u.id !== currentUserId,
    );
  }, [users, originalUserIds, currentUserId]);

  const showSearch = users.length > 5;
  const showBulkActions = canGrantAll || canRevokeAll;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage access to {app.name}</DialogTitle>
          {/* The flag is an auto-grant at join; the grants below stay the
              truth. The dialog's description, so it is read on open. */}
          {app.isDefault ? (
            <DialogDescription>
              Available to everyone: people who join later get access too.
              Unchecking someone here takes theirs away.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {/* Search and bulk actions */}
        {showSearch || showBulkActions ? (
          <div className="flex flex-wrap items-center gap-2">
            {showSearch ? (
              <InputGroup className="h-8 min-w-48 flex-1">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search users"
                  placeholder="Search users…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </InputGroup>
            ) : null}
            {showBulkActions ? (
              <div className="ml-auto flex gap-2">
                {canGrantAll ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGrantAll}
                    disabled={isSaving}
                  >
                    Grant all
                  </Button>
                ) : null}
                {canRevokeAll ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRevokeAll}
                    disabled={isSaving}
                  >
                    Revoke all
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* User list */}
        {isLoading ? (
          <div
            className="divide-y divide-border rounded-lg border border-border"
            aria-busy
          >
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="size-4" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            message="Failed to load users."
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        ) : (
          <ScrollBox className="max-h-72" deps={[filteredUsers]}>
            {filteredUsers.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {searchQuery
                  ? `No users match "${searchQuery}"`
                  : "No users in this organization yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filteredUsers.map((user: UserAccessState) => {
                  const isCurrentUser = user.id === currentUserId;
                  const isViaGroup = viaGroup.has(user.id);
                  const isViaGroupOnly = viaGroupOnly.has(user.id);
                  const isSelected =
                    selectedUserIds.has(user.id) || isViaGroupOnly;
                  const hadAccess = originalUserIds.has(user.id);
                  const isGranting =
                    isSelected && !hadAccess && !isViaGroupOnly;
                  // The direct grant goes: access with it, unless a group
                  // keeps them in.
                  const isRevoking = !isSelected && hadAccess && !isViaGroup;
                  const isKeptByGroup = !isSelected && hadAccess && isViaGroup;
                  const hasAccessAfter = isSelected || isViaGroup;
                  const displayName = user.name || user.email.split("@")[0];

                  return (
                    <li key={user.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted",
                          (isCurrentUser || isViaGroupOnly) &&
                            "cursor-not-allowed opacity-75",
                          isGranting && "bg-success/10 hover:bg-success/15",
                          isRevoking &&
                            "bg-destructive/10 hover:bg-destructive/15",
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleUser(user.id)}
                          disabled={isSaving || isCurrentUser || isViaGroupOnly}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {displayName}
                            </span>
                            {isCurrentUser ? (
                              <Badge variant="secondary" size="sm">
                                You
                              </Badge>
                            ) : null}
                            {user.status && user.status !== "active" ? (
                              <Badge
                                variant="warning"
                                size="sm"
                                className="capitalize"
                              >
                                {user.status}
                              </Badge>
                            ) : null}
                            {user.viaGroups.length ? (
                              <Badge
                                variant="info"
                                size="sm"
                                title={`Granted through ${user.viaGroups.join(", ")}`}
                              >
                                via {user.viaGroups.join(", ")}
                              </Badge>
                            ) : null}
                          </div>
                          {user.name && user.name !== user.email ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {user.email}
                            </p>
                          ) : null}
                        </div>
                        {isGranting ? (
                          <Badge variant="success">
                            <Plus />
                            Granting
                          </Badge>
                        ) : isRevoking ? (
                          <Badge variant="destructive">
                            <Minus />
                            Revoking
                          </Badge>
                        ) : isKeptByGroup ? (
                          <Badge
                            variant="secondary"
                            title={`Keeps access through ${user.viaGroups.join(", ")}`}
                          >
                            <Minus />
                            Direct grant removed
                          </Badge>
                        ) : (
                          <span
                            className={cn(
                              "shrink-0 text-xs text-muted-foreground",
                              !hasAccessAfter && "opacity-70",
                            )}
                          >
                            {hasAccessAfter ? "Has access" : "No access"}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollBox>
        )}

        {/* Summary: of a list that is in. */}
        {isLoading || isError ? null : (
          <div className="space-y-1 text-sm">
            {hasChanges &&
            (changes.granting.length > 0 ||
              changes.revoking.length > 0 ||
              changes.keptByGroup.length > 0) ? (
              <div className="flex flex-wrap gap-3">
                {changes.granting.length > 0 ? (
                  <span className="text-success">
                    +{changes.granting.length} gaining access
                  </span>
                ) : null}
                {changes.revoking.length > 0 ? (
                  <span className="text-destructive">
                    -{changes.revoking.length} losing access
                  </span>
                ) : null}
                {changes.keptByGroup.length > 0 ? (
                  <span className="text-muted-foreground">
                    {changes.keptByGroup.length} kept through groups
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>
                {outcome.withAccess} of {users.length} user
                {users.length !== 1 ? "s" : ""} will have access
                {outcome.throughGroups
                  ? ` (${outcome.throughGroups} through groups)`
                  : null}
              </span>
              {searchQuery && filteredUsers.length !== users.length ? (
                <span className="text-xs tabular-nums">
                  Showing {filteredUsers.length} of {users.length}
                </span>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!hasChanges}
            pending={isSaving}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
