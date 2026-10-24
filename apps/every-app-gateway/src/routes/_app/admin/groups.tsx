import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ChecklistDialog } from "@/client/components/admin/ChecklistDialog";
import { GroupDialog } from "@/client/components/admin/GroupDialog";
import { GroupsTable } from "@/client/components/admin/GroupsTable";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { getServerErrorMessage } from "@/client/errors";
import { useSession } from "@/client/hooks/useSession";
import { appStatusLabel } from "@/client/lib/appStatus";
import { adminAppsCollection } from "@/client/tanstack-db";
import {
  createGroup,
  deleteGroup,
  getGroupApps,
  getGroupMembers,
  listGroups,
  setGroupApps,
  setGroupMembers,
  updateGroup,
} from "@/serverFunctions/groups";
import type { GroupFormData } from "@/schemas/group";
import type { AdminGroup } from "@/types/group";

export const Route = createFileRoute("/_app/admin/groups")({
  component: GroupsPage,
});

const GROUPS_KEY = ["admin", "groups"] as const;

function GroupsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminGroup | null>(null);
  const [deleting, setDeleting] = useState<AdminGroup | null>(null);
  const [membersOf, setMembersOf] = useState<AdminGroup | null>(null);
  const [appsOf, setAppsOf] = useState<AdminGroup | null>(null);

  const groupsQuery = useQuery({
    queryKey: GROUPS_KEY,
    queryFn: () => listGroups(),
  });
  const groups = groupsQuery.data?.groups ?? [];

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: GROUPS_KEY });
    // Access counts on the Apps tab change with a group's grants.
    await adminAppsCollection.utils.refetch();
  };

  const deleteMutation = useMutation({
    mutationFn: (group: AdminGroup) => deleteGroup({ data: { id: group.id } }),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
      toast.success("Group deleted");
    },
    onError: (err) => {
      toast.error(getServerErrorMessage(err, "Failed to delete group"));
    },
  });

  const createAction = (
    <Button onClick={() => setCreating(true)}>
      <Plus data-icon="inline-start" />
      New group
    </Button>
  );

  return (
    <div className="space-y-6">
      <SectionHeader title="Groups" action={createAction} />

      <GroupsTable
        groups={groups}
        isLoading={groupsQuery.isLoading}
        error={
          groupsQuery.isError ? (
            <ErrorState
              message="Couldn't load groups."
              onRetry={() => void groupsQuery.refetch()}
            />
          ) : undefined
        }
        createAction={createAction}
        onManageMembers={setMembersOf}
        onManageApps={setAppsOf}
        onEdit={setEditing}
        onDelete={setDeleting}
      />

      {creating || editing ? (
        <GroupDialog
          group={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={async (values: GroupFormData) => {
            if (editing) {
              await updateGroup({ data: { id: editing.id, ...values } });
              toast.success("Group updated");
            } else {
              await createGroup({ data: values });
              toast.success("Group created");
            }
            setCreating(false);
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete group"
          destructive
          pending={deleteMutation.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteMutation.mutate(deleting)}
        >
          {deleting.memberCount > 0 && deleting.appCount > 0
            ? `Its ${deleting.memberCount} ${
                deleting.memberCount === 1 ? "member loses" : "members lose"
              } the ${deleting.appCount} ${
                deleting.appCount === 1 ? "app" : "apps"
              } it grants, unless they are granted directly or through another group. `
            : null}
          This action cannot be undone.
        </ConfirmDialog>
      ) : null}

      {membersOf ? (
        <GroupMembersDialog
          group={membersOf}
          onClose={() => setMembersOf(null)}
          onSaved={refresh}
        />
      ) : null}

      {appsOf ? (
        <GroupAppsDialog
          group={appsOf}
          onClose={() => setAppsOf(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function GroupMembersDialog({
  group,
  onClose,
  onSaved,
}: {
  group: AdminGroup;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const query = useQuery({
    queryKey: ["admin", "group-members", group.id],
    queryFn: () => getGroupMembers({ data: { id: group.id } }),
  });
  const users = query.data?.users ?? [];

  return (
    <ChecklistDialog
      title={`Members of ${group.name}`}
      description="Everyone checked can open the apps granted to this group."
      noun="user"
      items={users.map((user) => ({
        id: user.id,
        label: user.name || user.email.split("@")[0] || user.email,
        // The email once: a person whose name is their email reads it above.
        detail: user.name && user.name !== user.email ? user.email : undefined,
        badges: (
          <>
            {user.id === currentUserId ? (
              <Badge variant="secondary" size="sm">
                You
              </Badge>
            ) : null}
            {user.banned ? (
              <Badge variant="destructive" size="sm">
                Deactivated
              </Badge>
            ) : user.status && user.status !== "active" ? (
              <Badge variant="warning" size="sm" className="capitalize">
                {user.status}
              </Badge>
            ) : null}
          </>
        ),
      }))}
      initialSelectedIds={users.filter((u) => u.inGroup).map((u) => u.id)}
      isLoading={query.isLoading}
      isError={query.isError}
      isRefetching={query.isFetching}
      onRetry={() => void query.refetch()}
      onSave={async (userIds) => {
        try {
          await setGroupMembers({ data: { id: group.id, userIds } });
          await onSaved();
          toast.success("Members updated");
          onClose();
        } catch (err) {
          toast.error(getServerErrorMessage(err, "Failed to update members"));
        }
      }}
      onClose={onClose}
      emptyText="No users in this organization yet."
    />
  );
}

function GroupAppsDialog({
  group,
  onClose,
  onSaved,
}: {
  group: AdminGroup;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const query = useQuery({
    queryKey: ["admin", "group-apps", group.id],
    queryFn: () => getGroupApps({ data: { id: group.id } }),
  });
  const apps = query.data?.apps ?? [];

  return (
    <ChecklistDialog
      title={`Apps for ${group.name}`}
      description="Every member of the group can open the apps checked here."
      noun="app"
      items={apps.map((app) => ({
        id: app.id,
        label: app.name,
        detail: app.appId,
        // The usual state is plain; a deploy state short of it is a chip,
        // in the word the launcher and Admin → Apps use for it.
        badges:
          app.status !== "active" ? (
            <Badge variant="warning" size="sm">
              {appStatusLabel(app.status)}
            </Badge>
          ) : null,
      }))}
      initialSelectedIds={apps.filter((a) => a.granted).map((a) => a.id)}
      isLoading={query.isLoading}
      isError={query.isError}
      isRefetching={query.isFetching}
      onRetry={() => void query.refetch()}
      onSave={async (appRowIds) => {
        try {
          await setGroupApps({ data: { id: group.id, appRowIds } });
          await onSaved();
          toast.success("Apps updated");
          onClose();
        } catch (err) {
          toast.error(getServerErrorMessage(err, "Failed to update apps"));
        }
      }}
      onClose={onClose}
      emptyText="No apps to grant yet. Apps show up here once you deploy them."
    />
  );
}
