import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FolderScreen, SharedScreen, type Loadable } from "@every-app/desktop-ui";
import type { Folder } from "@shared/contract";
import { useRun } from "../actions";
import { api, keys } from "../api";
import { ConfirmDialog, NameDialog } from "../dialogs";
import { accountFrom, loadable } from "../map";
import { useAppState } from "../bridge";

function useOrgName(): string {
  const state = useAppState();
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  return accountFrom(me.data, state?.auth)?.orgName ?? "your team";
}

export function SharedPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const meetings = useQuery({ queryKey: keys.meetings({ shared: true }), queryFn: () => api.meetings({ shared: true }) });
  return (
    <SharedScreen
      meetings={loadable(meetings, (r) => r.meetings)}
      orgName={useOrgName()}
      onOpenMeeting={(id) => void navigate({ to: "/meetings/$id", params: { id } })}
      onRetry={() => void client.invalidateQueries({ queryKey: keys.allMeetings })}
    />
  );
}

export function FolderPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const run = useRun();
  const orgName = useOrgName();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const folders = useQuery({ queryKey: keys.folders, queryFn: () => api.folders().then((r) => r.folders) });
  const meetings = useQuery({ queryKey: keys.meetings({ folderId: id }), queryFn: () => api.meetings({ folderId: id }) });
  const templates = useQuery({ queryKey: keys.templates, queryFn: api.templates });

  const found = folders.data?.find((f) => f.id === id);
  const folder: Loadable<Folder> =
    folders.isPending
      ? { status: "loading" }
      : folders.isError
        ? { status: "error", message: "Couldn't load your folders." }
        : found
          ? { status: "ready", data: found }
          : { status: "error", message: "This folder was deleted, or you no longer have access to it." };

  return (
    <>
      <FolderScreen
        key={id}
        folder={folder}
        meetings={loadable(meetings, (r) => r.meetings)}
        orgName={orgName}
        templates={templates.data?.templates.filter((t) => found?.space !== "team" || t.builtIn || t.visibility === "team")}
        onOpenMeeting={(meetingId) => void navigate({ to: "/meetings/$id", params: { id: meetingId } })}
        onRename={() => setDialog("rename")}
        onDelete={() => setDialog("delete")}
        onSetDefaultTemplate={(defaultTemplateId) =>
          void run(() => api.updateFolder(id, { defaultTemplateId }), "Couldn't change the folder's template.", [keys.folders])
        }
        onRetry={() => {
          void client.invalidateQueries({ queryKey: keys.folders });
          void client.invalidateQueries({ queryKey: keys.allMeetings });
        }}
      />
      <NameDialog
        open={dialog === "rename"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rename folder"
        submitLabel="Rename"
        initialName={found?.name}
        onSubmit={async (name) => {
          await run(() => api.updateFolder(id, { name }), "Couldn't rename the folder.", [keys.folders]);
          setDialog(null);
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete “${found?.name ?? "folder"}”?`}
        description="The meetings in it stay; they're only taken out of this folder."
        confirmLabel="Delete folder"
        onConfirm={() => {
          setDialog(null);
          void run(async () => {
            await api.deleteFolder(id);
            await navigate({ to: "/" });
          }, "Couldn't delete the folder.", [keys.folders]);
        }}
      />
    </>
  );
}
