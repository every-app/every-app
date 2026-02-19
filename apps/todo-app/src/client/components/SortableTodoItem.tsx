import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Checkbox } from "@/client/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { MoreHorizontal, Edit, Trash2, CalendarDays, X } from "lucide-react";
import { toast } from "sonner";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { todoCollection } from "@/client/tanstack-db";
import { getTodoItemId, getTodoInlineEditId } from "@/client/lib/element-ids";
import {
  extractDueDateFromInput,
  formatDueDateBadge,
} from "@/client/lib/due-date-parser";
import { TiptapTodoInput } from "@/client/components/TiptapTodoInput";

interface SortableTodoItemProps {
  todo: Todo;
  editingTodoId: string | null;
  setEditingTodoId: React.Dispatch<React.SetStateAction<string | null>>;
  isDraggable?: boolean;
  onToggleComplete?: (todoId: string, completed: boolean) => void;
}

export function SortableTodoItem({
  todo,
  editingTodoId,
  setEditingTodoId,
  isDraggable = true,
  onToggleComplete,
}: SortableTodoItemProps) {
  const [localTitle, setLocalTitle] = useState(todo.title);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);
  const skipBlurSaveRef = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: todo.id,
    disabled: !isDraggable,
  });

  // Combine dnd-kit's setNodeRef with our containerRef
  const setCombinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const parsedInlineInput = useMemo(
    () => extractDueDateFromInput(localTitle),
    [localTitle],
  );
  const detectedInlineDueDate =
    editingTodoId === todo.id &&
    parsedInlineInput.dueDate &&
    parsedInlineInput.matchedText
      ? parsedInlineInput.dueDate
      : null;
  const showDetectedDueDateHint =
    detectedInlineDueDate !== null && detectedInlineDueDate !== todo.dueDate;

  const handleTitleChange = (newTitle: string) => {
    if (todo.completed) return;
    setLocalTitle(newTitle);
  };

  const isEditable = useCallback(() => {
    if (todo.completed) {
      toast.error("Cannot edit completed todos. Unmark as completed first.");
      return false;
    }
    return true;
  }, [todo.completed]);

  const stopEditing = useCallback(() => {
    setEditingTodoId(null);
    containerRef.current?.focus();
  }, [setEditingTodoId]);

  const handleTitleSave = () => {
    const currentValue = localTitle.trim();

    if (todo.completed) {
      setLocalTitle(todo.title);
      return;
    }

    const nextTitle = parsedInlineInput.title.trim();
    const nextDueDate = parsedInlineInput.matchedText
      ? parsedInlineInput.dueDate
      : todo.dueDate;

    if (!nextTitle) {
      toast.error("Todo title cannot be empty");
      setLocalTitle(todo.title);
      return;
    }

    if (nextTitle !== todo.title || nextDueDate !== todo.dueDate) {
      todoCollection.update(todo.id, (draft) => {
        draft.title = nextTitle;
        draft.dueDate = nextDueDate;
      });
    }
  };

  const handleInputFocus = () => {
    if (todo.completed) return;
    setEditingTodoId(todo.id);
  };

  const handleInputBlur = () => {
    if (todo.completed) return;

    if (skipBlurSaveRef.current) {
      skipBlurSaveRef.current = false;
      return;
    }

    setEditingTodoId(null);
    handleTitleSave();
  };

  const handleClickEditTodo = () => {
    if (!isEditable()) return;

    setEditingTodoId(todo.id);
  };

  const handleClickChangeDueDate = (anchorElement?: HTMLElement | null) => {
    if (!isEditable()) return;

    const input = dueDateInputRef.current;
    const trigger = anchorElement ?? dropdownTriggerRef.current;
    if (!input || !trigger) return;

    // Position the portal-mounted date input near the trigger so
    // native picker popovers open next to the dropdown area.
    const rect = trigger.getBoundingClientRect();
    input.style.top = `${Math.round(rect.bottom + 6)}px`;
    input.style.left = `${Math.round(rect.right - 2)}px`;

    input.focus({ preventScroll: true });
    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      input.click();
    }
  };

  const handleClearDueDate = () => {
    if (!isEditable()) return;
    todoCollection.update(todo.id, (draft) => {
      draft.dueDate = null;
    });
  };

  useEffect(() => {
    if (editingTodoId === todo.id) return;
    setLocalTitle(todo.title);
  }, [editingTodoId, todo.id, todo.title]);

  // !outline-none !ring-0 focus:!ring-0 - Force hide browser default focus styles that cause fat corners
  return (
    <div
      ref={setCombinedRef}
      style={style}
      {...(isDraggable ? attributes : {})}
      {...(isDraggable ? listeners : {})}
      id={getTodoItemId(todo.id)}
      tabIndex={0}
      className={`flex items-start gap-3 p-2 rounded-lg border !outline-none !ring-0 focus:!ring-0 ${
        isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      } ${
        isDragging
          ? "z-50 bg-base-200 shadow-lg border-base-300"
          : editingTodoId === todo.id
            ? "border-base-300 bg-base-300/50"
            : "border-transparent hover:bg-base-200 focus:border-primary focus:bg-base-300/50"
      }`}
    >
      {/* before:absolute before:inset-[-8px] creates an invisible hit area extending 8px beyond the checkbox */}
      <Checkbox
        checked={todo.completed}
        onCheckedChange={(checked) => {
          onToggleComplete?.(todo.id, Boolean(checked));
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Stop Space/Enter from bubbling to dnd-kit's KeyboardSensor
          // so native checkbox toggle works
          if (e.key === " " || e.key === "Enter") {
            e.stopPropagation();
          }
        }}
        className="mt-1.5 flex-shrink-0 relative before:absolute before:inset-[-8px] before:content-['']"
        aria-label={
          todo.completed
            ? `Mark as incomplete: "${todo.title}"`
            : `Mark as complete ${todo.title}`
        }
      />

      <div className="flex-1">
        <TiptapTodoInput
          inputId={getTodoInlineEditId(todo.id)}
          value={localTitle}
          onChange={handleTitleChange}
          multiline
          variant="inline"
          focused={editingTodoId === todo.id}
          disabled={todo.completed}
          ariaLabel={
            todo.completed
              ? `Completed todo: ${todo.title}`
              : `Edit todo: ${todo.title}`
          }
          className={`todo-tiptap-input todo-tiptap-input--inline ${
            isDragging
              ? "!cursor-grabbing"
              : todo.completed
                ? "line-through text-base-content/50 cursor-default"
                : "cursor-text"
          }`}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onPointerDown={(e) => {
            if (editingTodoId === todo.id) {
              e.stopPropagation();
            }
          }}
          onEnter={() => {
            skipBlurSaveRef.current = true;
            handleTitleSave();
            stopEditing();
          }}
          onEscape={() => {
            setLocalTitle(todo.title);
            stopEditing();
          }}
        />
        {showDetectedDueDateHint && detectedInlineDueDate && (
          <div className="mt-1 px-2">
            <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs text-primary">
              On save: Due {formatDueDateBadge(detectedInlineDueDate)}
            </span>
          </div>
        )}
        {todo.dueDate && !showDetectedDueDateHint && (
          <div className="mt-1 px-2">
            {todo.completed ? (
              <span className="inline-flex items-center rounded-full bg-base-300 text-xs px-2 py-0.5 text-base-content/70">
                Due {formatDueDateBadge(todo.dueDate)}
              </span>
            ) : (
              <div className="group relative inline-flex items-center overflow-hidden rounded-full border border-base-300 bg-base-300/70 text-xs text-base-content/70">
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClearDueDate();
                  }}
                  className="absolute left-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-base-content/50 opacity-0 transition-all duration-200 hover:bg-error/10 hover:text-error group-hover:opacity-100 group-focus-within:opacity-100"
                  aria-label="Clear due date"
                >
                  <X className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClickChangeDueDate(event.currentTarget);
                  }}
                  className="inline-flex items-center px-3 py-0.5 transition-all duration-200 hover:text-primary group-hover:pl-6 group-focus-within:pl-6"
                  aria-label={`Edit due date, currently ${formatDueDateBadge(todo.dueDate)}`}
                >
                  Due {formatDueDateBadge(todo.dueDate)}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          ref={dropdownTriggerRef}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Stop Space/Enter from bubbling to dnd-kit's KeyboardSensor
            // so dropdown can be opened with keyboard
            if (e.key === " " || e.key === "Enter") {
              e.stopPropagation();
            }
          }}
          className="rounded transition-all duration-200 hover:bg-base-300 p-1 focus:ring-2 focus:ring-primary focus:ring-offset-1"
          aria-label="More actions"
        >
          <MoreHorizontal className="h-4 w-4 text-base-content/60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={!todo.completed ? handleClickEditTodo : undefined}
            disabled={todo.completed}
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit {todo.completed && "(Disabled)"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={
              !todo.completed ? () => handleClickChangeDueDate() : undefined
            }
            disabled={todo.completed}
          >
            <CalendarDays className="h-4 w-4 mr-2" />
            Due Date
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setShowDeleteModal(true)}
            className="text-error focus:text-error focus:bg-error/10"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {typeof document !== "undefined" &&
        createPortal(
          <input
            ref={dueDateInputRef}
            type="date"
            value={todo.dueDate ?? ""}
            onChange={(event) => {
              todoCollection.update(todo.id, (draft) => {
                draft.dueDate = event.target.value || null;
              });
            }}
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />,
          document.body,
        )}

      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={() => todoCollection.delete(todo.id)}
        title="Delete Todo"
        description="Are you sure you want to delete this todo? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}
