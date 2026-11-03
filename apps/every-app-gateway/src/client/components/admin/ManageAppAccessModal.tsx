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
import { getServerErrorMessage } from "@/client/errors";
import { getAppAccessState, updateAppAccess } from "@/serverFunctions/apps";
import { adminAppsCollection } from "@/client/tanstack-db";
import type { AppWithAccessCount, UserAccessState } from "@/types/app";

interface ManageAppAccessModalProps {
  app: AppWithAccessCount;
  onClose: () => void;
}

/**
 * Picks who holds a person's grant to an app. Someone who opens it another
 * way keeps it whatever their box says: an owner or admin (their role), a
 * member of a group holding it (the group's name is shown), or everyone
 * while the app is available to everyone. A role or a group as the only
 * way in shows the box checked and disabled; while the app is available to
 * everyone the boxes stay editable, so an admin can pick who keeps it once
 * that is turned off (as `workspace app access --add` can). With a grant
 * too, unchecking removes the grant while the other way keeps them in.
 * Saving sends the grant list alone. Render it only while it is open.
 */
export function ManageAppAccessModal({
  app,
  onClose,
}: ManageAppAccessModalProps) {
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
  const everyone = data?.everyone ?? app.everyone;
  /** Users who open the app another way: they keep it whatever the grant list says. */
  const keptOtherwise = useMemo(
    () =>
      new Set(
        users
          .filter(
            (u: UserAccessState) =>
              everyone || u.admin || u.viaGroups.length > 0,
          )
          .map((u: UserAccessState) => u.id),
      ),
    [users, everyone],
  );
  /**
   * Users with no grant whom their role or a group lets in: shown checked,
   * not editable here. "Everyone" doesn't lock a box: the grant is what
   * stays when the flag goes off.
   */
  const keptOnly = useMemo(
    () =>
      new Set(
        users
          .filter(
            (u: UserAccessState) =>
              !u.hasAccess && (u.admin || u.viaGroups.length > 0),
          )
          .map((u: UserAccessState) => u.id),
      ),
    [users],
  );

  const toggleUser = (userId: string) => {
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

  // A grant for everyone who doesn't open it another way already.
  const handleGrantAll = () => {
    if (data?.users) {
      setSelectedUserIds(
        new Set(
          data.users
            .filter(
              (u: UserAccessState) =>
                originalUserIds.has(u.id) || !keptOnly.has(u.id),
            )
            .map((u: UserAccessState) => u.id),
        ),
      );
      setHasChanges(true);
    }
  };

  // Every grant goes; whoever opens it another way keeps it.
  const handleRevokeAll = () => {
    setSelectedUserIds(new Set());
    setHasChanges(true);
  };

  const handleSave = async () => {
    const userIds = Array.from(selectedUserIds);

    setIsSaving(true);
    try {
      // Update access on server, then refetch to get accurate access count
      // Note: We don't use collection.update() here because accessCount is
      // derived (effective-access.ts), not an app field
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
      user.hasAccess || keptOtherwise.has(user.id);
    return [...matching].sort(
      (a, b) => Number(hadAccess(b)) - Number(hadAccess(a)),
    );
  }, [users, searchQuery, keptOtherwise]);

  // What's changing: who gains access, who loses it, and whose grant
  // goes while another way keeps them in.
  const changes = useMemo(() => {
    const granting: string[] = [];
    const revoking: string[] = [];
    const keptAnotherWay: string[] = [];

    for (const userId of selectedUserIds) {
      if (!originalUserIds.has(userId) && !keptOtherwise.has(userId)) {
        granting.push(userId);
      }
    }
    for (const userId of originalUserIds) {
      if (!selectedUserIds.has(userId)) {
        (keptOtherwise.has(userId) ? keptAnotherWay : revoking).push(userId);
      }
    }

    return { granting, revoking, keptAnotherWay };
  }, [selectedUserIds, originalUserIds, keptOtherwise]);

  // Who opens the app once saved: the grant list, and everyone who opens it
  // another way; of those, how many another way alone.
  const outcome = useMemo(() => {
    const withAccess = users.filter(
      (u: UserAccessState) =>
        selectedUserIds.has(u.id) || keptOtherwise.has(u.id),
    );
    return {
      withAccess: withAccess.length,
      otherwise: withAccess.filter((u) => !selectedUserIds.has(u.id)).length,
    };
  }, [users, selectedUserIds, keptOtherwise]);

  // Bulk actions show when they would change something.
  const canGrantAll = useMemo(
    () =>
      users.some(
        (u: UserAccessState) =>
          !originalUserIds.has(u.id) && !keptOnly.has(u.id),
      ),
    [users, originalUserIds, keptOnly],
  );

  const canRevokeAll = useMemo(
    () => users.some((u: UserAccessState) => originalUserIds.has(u.id)),
    [users, originalUserIds],
  );

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
          {/* The dialog's description, so it is read on open. */}
          <DialogDescription>
            {everyone
              ? "Available to everyone: every member opens it, people who join later too. The people checked here keep it if that is turned off."
              : "Owners and admins open every app. Check the members who should open this one, or grant it to a group."}
          </DialogDescription>
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
                  const isKept = keptOtherwise.has(user.id);
                  const isKeptOnly = keptOnly.has(user.id);
                  const isSelected = selectedUserIds.has(user.id) || isKeptOnly;
                  const hadAccess = originalUserIds.has(user.id);
                  const isGranting = isSelected && !hadAccess && !isKept;
                  // The grant goes: access with it, unless another way
                  // keeps them in.
                  const isRevoking = !isSelected && hadAccess && !isKept;
                  const isKeptAnotherWay = !isSelected && hadAccess && isKept;
                  const hasAccessAfter = isSelected || isKept;
                  const displayName = user.name || user.email.split("@")[0];

                  return (
                    <li key={user.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted",
                          isKeptOnly && "cursor-not-allowed opacity-75",
                          isGranting && "bg-success/10 hover:bg-success/15",
                          isRevoking &&
                            "bg-destructive/10 hover:bg-destructive/15",
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleUser(user.id)}
                          disabled={isSaving || isKeptOnly}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {displayName}
                            </span>
                            {user.admin ? (
                              <Badge
                                variant="secondary"
                                size="sm"
                                title="Owners and admins open every app"
                              >
                                Admin
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
                        ) : isKeptAnotherWay ? (
                          <Badge variant="secondary" title="Keeps access">
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
              changes.keptAnotherWay.length > 0) ? (
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
                {changes.keptAnotherWay.length > 0 ? (
                  <span className="text-muted-foreground">
                    {changes.keptAnotherWay.length} kept another way
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>
                {outcome.withAccess} of {users.length} user
                {users.length !== 1 ? "s" : ""} will have access
                {outcome.otherwise
                  ? ` (${outcome.otherwise} without a grant)`
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
