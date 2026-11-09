import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TemplatesScreen } from "@every-app/desktop-ui";
import { useRun } from "../actions";
import { api, keys } from "../api";
import { ConfirmDialog } from "../dialogs";
import { accountFrom, loadable } from "../map";
import { useAppState } from "../bridge";

export function TemplatesPage({ selected }: { selected?: string }) {
  const state = useAppState();
  const navigate = useNavigate();
  const client = useQueryClient();
  const run = useRun();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const templates = useQuery({ queryKey: keys.templates, queryFn: api.templates });
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  const select = (id: string | undefined) => void navigate({ to: "/templates", search: id ? { id } : {} });
  const refresh = () => client.invalidateQueries({ queryKey: keys.templates });
  const toDelete = templates.data?.templates.find((t) => t.id === deleting);

  return (
    <>
      <TemplatesScreen
        templates={loadable(templates, (r) => r.templates)}
        selectedId={selected ?? null}
        defaultTemplateId={templates.data?.defaultTemplateId ?? "general"}
        orgName={accountFrom(me.data, state?.auth)?.orgName ?? "Team"}
        saving={saving}
        onSelect={select}
        onNew={() => select("new")}
        onSave={(id, draft) => {
          setSaving(true);
          void run(async () => {
            const { template } = id ? await api.updateTemplate(id, draft) : await api.createTemplate(draft);
            await refresh();
            select(template.id);
          }, "Couldn't save the template.").finally(() => setSaving(false));
        }}
        onDuplicate={(template) =>
          void run(async () => {
            const { template: copy } = await api.duplicateTemplate(template.id);
            await refresh();
            select(copy.id);
          }, "Couldn't duplicate the template.")
        }
        onDelete={setDeleting}
        onMakeDefault={(defaultTemplateId) =>
          void run(() => api.updateSettings({ defaultTemplateId }), "Couldn't change your default template.", [keys.templates, keys.settings])
        }
        onRetry={() => void refresh()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${toDelete?.name ?? "template"}”?`}
        description="Notes already written with it stay as they are."
        confirmLabel="Delete template"
        onConfirm={() => {
          const id = deleting;
          setDeleting(null);
          if (!id) return;
          void run(async () => {
            await api.deleteTemplate(id);
            select(undefined);
          }, "Couldn't delete the template.", [keys.templates]);
        }}
      />
    </>
  );
}
