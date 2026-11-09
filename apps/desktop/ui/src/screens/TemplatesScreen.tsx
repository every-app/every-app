import { cn } from "cn";
import {
  Copy,
  LayoutTemplate,
  Lock,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import type { Loadable, Space, Template } from "../types";
import { EmptyState, ErrorState } from "./parts";

export interface TemplateDraft {
  name: string;
  instructions: string;
  visibility: Space;
}

export interface TemplatesScreenProps {
  templates: Loadable<Template[]>;
  /** The template open in the editor; "new" for an unsaved one. */
  selectedId: string | "new" | null;
  defaultTemplateId: string;
  orgName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSave: (id: string | null, draft: TemplateDraft) => void;
  onDelete?: (id: string) => void;
  onDuplicate?: (template: Template) => void;
  onMakeDefault?: (id: string) => void;
  onRetry?: () => void;
  saving?: boolean;
}

export function TemplatesScreen(props: TemplatesScreenProps) {
  const { templates } = props;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-4 pb-2">
          <h1 className="text-[15px] font-semibold">Templates</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New template"
            onClick={props.onNew}
          >
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {templates.status === "loading" && (
            <div
              aria-busy
              aria-label="Loading"
              className="flex flex-col gap-3 p-2"
            >
              {[70, 50, 60, 40].map((w) => (
                <Skeleton
                  key={w}
                  className="h-3.5"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          )}
          {templates.status === "error" && (
            <p className="px-2 py-2 text-[12px] text-destructive">
              Couldn't load templates.
            </p>
          )}
          {templates.status === "ready" && (
            <TemplateList {...props} items={templates.data} />
          )}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-10 pb-10 pt-1">
          <EditorPane {...props} />
        </div>
      </div>
    </div>
  );
}

function TemplateList({
  items,
  selectedId,
  defaultTemplateId,
  orgName,
  onSelect,
}: TemplatesScreenProps & { items: Template[] }) {
  const groups = [
    { label: "Built in", items: items.filter((t) => t.builtIn) },
    { label: "Mine", items: items.filter((t) => !t.builtIn && t.mine) },
    { label: orgName, items: items.filter((t) => !t.builtIn && !t.mine) },
  ].filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.label}>
          <h2 className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
            {group.label}
          </h2>
          <ul className="flex flex-col gap-px">
            {group.items.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={selectedId === t.id ? "true" : undefined}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
                    selectedId === t.id
                      ? "bg-foreground/[0.07] font-medium"
                      : "text-foreground/80 hover:bg-foreground/[0.04]",
                  )}
                >
                  <span className="truncate">{t.name}</span>
                  {t.id === defaultTemplateId && (
                    <Star className="ml-auto size-3 shrink-0 fill-current text-foreground/40" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function EditorPane(props: TemplatesScreenProps) {
  const { templates, selectedId } = props;
  if (templates.status === "error") {
    return <ErrorState message={templates.message} onRetry={props.onRetry} />;
  }
  if (templates.status === "loading") {
    return (
      <div aria-busy className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (selectedId === "new")
    return <Editor key="new" {...props} template={null} />;
  const template = templates.data.find((t) => t.id === selectedId);
  if (!template) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title="Pick a template"
        className="mt-10"
      >
        A template tells Every App how to write the notes: which sections, how much
        detail, what to pull out.
      </EmptyState>
    );
  }
  return <Editor key={template.id} {...props} template={template} />;
}

function Editor({
  template,
  defaultTemplateId,
  orgName,
  onSave,
  onDelete,
  onDuplicate,
  onMakeDefault,
  saving,
}: TemplatesScreenProps & { template: Template | null }) {
  const editable = !template || (template.mine && !template.builtIn);
  const initial: TemplateDraft = {
    name: template?.name ?? "",
    instructions: template?.instructions ?? "",
    visibility: template?.visibility ?? "private",
  };
  const [draft, setDraft] = useState(initial);
  const dirty =
    draft.name !== initial.name ||
    draft.instructions !== initial.instructions ||
    draft.visibility !== initial.visibility;
  const isDefault = template?.id === defaultTemplateId;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && draft.name.trim()) onSave(template?.id ?? null, draft);
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <input
          data-slot="title-input"
          aria-label="Template name"
          placeholder="Template name"
          readOnly={!editable}
          value={draft.name}
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          className="min-w-0 flex-1 bg-transparent text-[22px] font-semibold tracking-[-0.015em] outline-none placeholder:text-muted-foreground/60"
        />
        {template && (
          <div className="flex shrink-0 items-center gap-1 pt-1">
            {isDefault ? (
              <span className="inline-flex h-7 items-center gap-1.5 px-2 text-[12px] text-muted-foreground">
                <Star className="size-3 fill-current" />
                Default
              </span>
            ) : (
              onMakeDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => onMakeDefault(template.id)}
                >
                  <Star />
                  Make default
                </Button>
              )
            )}
            {onDuplicate && (
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Duplicate"
                onClick={() => onDuplicate(template)}
              >
                <Copy />
              </Button>
            )}
            {editable && onDelete && (
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Delete"
                onClick={() => onDelete(template.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </div>

      {template?.builtIn && (
        <p className="-mt-2 text-[12px] text-muted-foreground">
          Built in. Duplicate it to make your own version.
        </p>
      )}
      {template && !template.builtIn && !template.mine && (
        <p className="-mt-2 text-[12px] text-muted-foreground">
          Shared by a teammate. Duplicate it to change it.
        </p>
      )}

      <label className="flex flex-col gap-2">
        <span className="text-[12px] font-medium text-muted-foreground">
          Instructions
        </span>
        <textarea
          data-slot="template-instructions"
          readOnly={!editable}
          value={draft.instructions}
          placeholder={
            '## Summary\nTwo or three sentences.\n\n## Action items\nBullets as "- [ ] owner: task".'
          }
          onChange={(event) =>
            setDraft({ ...draft, instructions: event.target.value })
          }
          rows={10}
          // Grows to fit the template, so a built-in reads whole without scrolling.
          className="field-sizing-content min-h-60 w-full resize-y rounded-lg border border-border bg-card px-3.5 py-3 text-[13.5px] leading-relaxed outline-none transition-shadow placeholder:text-muted-foreground/60 read-only:bg-muted/50 read-only:text-foreground/75 focus:border-ring/50 focus:ring-3 focus:ring-ring/15"
        />
      </label>

      {editable && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[12px] font-medium text-muted-foreground">
            Who can use it
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  value: "private",
                  icon: Lock,
                  title: "Only me",
                  hint: "In your template list only",
                },
                {
                  value: "team",
                  icon: Users,
                  title: orgName,
                  hint: "Everyone can write notes with it",
                },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={draft.visibility === option.value}
                onClick={() => setDraft({ ...draft, visibility: option.value })}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  draft.visibility === option.value
                    ? "border-foreground/30 bg-foreground/[0.03]"
                    : "border-border hover:bg-foreground/[0.02]",
                )}
              >
                <option.icon className="mt-0.5 size-3.5 text-foreground/60" />
                <span>
                  <span className="block text-[13px] font-medium">
                    {option.title}
                  </span>
                  <span className="block text-[12px] text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {editable && (
        <div className="flex justify-end gap-2 pt-1">
          {template && dirty && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setDraft(initial)}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={!dirty || !draft.name.trim()}
            pending={saving}
          >
            {template ? "Save" : "Create template"}
          </Button>
        </div>
      )}
    </form>
  );
}
