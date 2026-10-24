import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Minus, Plus, Search } from "lucide-react";
import { cn } from "cn";
import { ErrorState } from "@/client/components/ErrorState";
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

type ChecklistItem = {
  id: string;
  label: string;
  /** A second line under the label, for example an email or an app id. */
  detail?: string;
  /** Badges beside the label, for example "You" or "Deactivated". */
  badges?: ReactNode;
};

interface ChecklistDialogProps {
  title: string;
  description: string;
  /** What one row is, for the search box and the summary: "user" or "app". */
  noun: string;
  items: ChecklistItem[];
  /** The ids checked when the dialog opens. */
  initialSelectedIds: string[];
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  onRetry: () => void;
  /** Called with the full list of checked ids. Resolves once saved. */
  onSave: (ids: string[]) => Promise<void>;
  onClose: () => void;
  emptyText: string;
}

/**
 * A searchable checkbox list with "Select all" and "Clear", modelled on
 * ManageAppAccessModal: rows being added or removed are coloured, and the
 * footer counts the change. Render it only while it is open.
 */
export function ChecklistDialog({
  title,
  description,
  noun,
  items,
  initialSelectedIds,
  isLoading,
  isError,
  isRefetching,
  onRetry,
  onSave,
  onClose,
  emptyText,
}: ChecklistDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // The server's list, once it loads.
  const initialKey = initialSelectedIds.join("\n");
  useEffect(() => {
    if (isLoading) return;
    const ids = new Set(initialKey ? initialKey.split("\n") : []);
    setSelected(ids);
    setOriginal(new Set(ids));
  }, [initialKey, isLoading]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        (item.detail ?? "").toLowerCase().includes(query),
    );
  }, [items, searchQuery]);

  const adding = [...selected].filter((id) => !original.has(id)).length;
  const removing = [...original].filter((id) => !selected.has(id)).length;
  const hasChanges = adding > 0 || removing > 0;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave([...selected]);
    } finally {
      setIsSaving(false);
    }
  };

  const showSearch = items.length > 5;
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {showSearch || items.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {showSearch ? (
              <InputGroup className="h-8 min-w-48 flex-1">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label={`Search ${noun}s`}
                  placeholder={`Search ${noun}s…`}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </InputGroup>
            ) : null}
            {items.length > 0 ? (
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSaving || selected.size === items.length}
                  onClick={() => setSelected(new Set(items.map((i) => i.id)))}
                >
                  Select all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSaving || selected.size === 0}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

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
            message={`Failed to load ${noun}s.`}
            onRetry={onRetry}
            isRetrying={isRefetching}
          />
        ) : (
          <div className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {searchQuery
                  ? `No ${noun}s match "${searchQuery.trim()}"`
                  : emptyText}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((item) => {
                  const isSelected = selected.has(item.id);
                  const was = original.has(item.id);
                  const isAdding = isSelected && !was;
                  const isRemoving = !isSelected && was;
                  return (
                    <li key={item.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted",
                          isAdding && "bg-success/10 hover:bg-success/15",
                          isRemoving &&
                            "bg-destructive/10 hover:bg-destructive/15",
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggle(item.id)}
                          disabled={isSaving}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {item.label}
                            </span>
                            {item.badges}
                          </div>
                          {item.detail ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {item.detail}
                            </p>
                          ) : null}
                        </div>
                        {isAdding ? (
                          <Badge variant="success">
                            <Plus />
                            Adding
                          </Badge>
                        ) : isRemoving ? (
                          <Badge variant="destructive">
                            <Minus />
                            Removing
                          </Badge>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* The count is of a list that is in. */}
        {isLoading || isError ? null : (
          <div className="space-y-1 text-sm">
            {hasChanges ? (
              <div className="flex flex-wrap gap-3">
                {adding > 0 ? (
                  <span className="text-success">+{adding} adding</span>
                ) : null}
                {removing > 0 ? (
                  <span className="text-destructive">-{removing} removing</span>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>
                {selected.size} of {plural(items.length)} selected
              </span>
              {searchQuery && filtered.length !== items.length ? (
                <span className="text-xs tabular-nums">
                  Showing {filtered.length} of {items.length}
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
