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
import { DayPicker } from "react-day-picker";
import { todoCollection } from "@/client/tanstack-db";
import { getTodoItemId, getTodoInlineEditId } from "@/client/lib/element-ids";
import {
  extractDueDateFromInput,
  formatDueDateBadge,
} from "@/client/lib/due-date-parser";
import { formatDateKey } from "@/lib/date-key";
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
  const [isDueDatePickerOpen, setIsDueDatePickerOpen] = useState(false);
  const [selectedDueDate, setSelectedDueDate] = useState<Date | undefined>();
  const [dueDatePopoverPosition, setDueDatePopoverPosition] = useState({
    top: 0,
    left: 0,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dueDatePopoverRef = useRef<HTMLDivElement>(null);
  const dueDateTriggerRef = useRef<HTMLButtonElement>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);
  const skipBlurSaveRef = useRef(false);

  const parseDateKeyToDate = useCallback(
    (dateKey: string | null | undefined) => {
      if (!dateKey) return undefined;
      const [yearText, monthText, dayText] = dateKey.split("-");
      const year = Number.parseInt(yearText, 10);
      const month = Number.parseInt(monthText, 10);
      const day = Number.parseInt(dayText, 10);
      if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
        return undefined;
      }
      const date = new Date(year, month - 1, day);
      if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
      ) {
        return undefined;
      }
      return date;
    },
    [],
  );

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

  const handleClickChangeDueDate = () => {
    if (!isEditable()) return;

    setSelectedDueDate(parseDateKeyToDate(todo.dueDate));
    setIsDueDatePickerOpen(true);
  };

  const handleSelectDueDate = (nextDate: Date | undefined) => {
    if (!isEditable()) return;

    if (!nextDate) {
      todoCollection.update(todo.id, (draft) => {
        draft.dueDate = null;
      });
      setIsDueDatePickerOpen(false);
      return;
    }

    todoCollection.update(todo.id, (draft) => {
      draft.dueDate = formatDateKey(nextDate);
    });
    setSelectedDueDate(nextDate);
    setIsDueDatePickerOpen(false);
  };

  const updateDueDatePopoverPosition = useCallback(() => {
    const anchorElement =
      dueDateTriggerRef.current ??
      dropdownTriggerRef.current ??
      containerRef.current;
    if (!anchorElement) return;

    const anchorRect = anchorElement.getBoundingClientRect();
    const popoverWidth = 320;
    const viewportPadding = 8;
    const desiredLeft = anchorRect.left;
    const maxLeft = window.innerWidth - popoverWidth - viewportPadding;
    const left = Math.max(viewportPadding, Math.min(desiredLeft, maxLeft));

    const desiredTop = anchorRect.bottom + 8;
    const estimatedPopoverHeight = 360;
    const shouldPlaceAbove =
      desiredTop + estimatedPopoverHeight >
      window.innerHeight - viewportPadding;
    const top = shouldPlaceAbove
      ? Math.max(viewportPadding, anchorRect.top - estimatedPopoverHeight - 8)
      : desiredTop;

    setDueDatePopoverPosition({ top, left });
  }, []);

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

  useEffect(() => {
    if (!isDueDatePickerOpen) return;

    updateDueDatePopoverPosition();

    const handleOutsidePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      const clickedInsidePopover = dueDatePopoverRef.current?.contains(target);
      const clickedOnTrigger = dueDateTriggerRef.current?.contains(target);
      if (!clickedInsidePopover && !clickedOnTrigger) {
        setIsDueDatePickerOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsDueDatePickerOpen(false);
      }
    };

    const handleReposition = () => {
      updateDueDatePopoverPosition();
    };

    document.addEventListener("mousedown", handleOutsidePointerDown);
    document.addEventListener("touchstart", handleOutsidePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("mousedown", handleOutsidePointerDown);
      document.removeEventListener("touchstart", handleOutsidePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isDueDatePickerOpen, updateDueDatePopoverPosition]);

  const dayPickerClassNames = useMemo(
    () => ({
      month: "space-y-3",
      caption: "flex items-center justify-between px-1",
      caption_label: "font-medium text-sm text-base-content",
      nav: "flex items-center gap-1",
      button_previous:
        "btn btn-ghost btn-xs min-h-0 h-7 w-7 p-0 rounded-md text-base-content/70 hover:text-base-content",
      button_next:
        "btn btn-ghost btn-xs min-h-0 h-7 w-7 p-0 rounded-md text-base-content/70 hover:text-base-content",
      chevron: "h-4 w-4 stroke-current",
      weekdays: "grid grid-cols-7 gap-1",
      weekday: "text-xs text-base-content/50 text-center py-1",
      week: "grid grid-cols-7 gap-1",
      day: "text-center",
      day_button:
        "h-8 w-8 rounded-md text-sm transition-colors hover:bg-base-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-base-content",
      selected:
        "[&>button]:bg-primary [&>button]:text-primary-content [&>button]:hover:bg-primary",
      today:
        "[&>button]:border [&>button]:border-primary/40 [&>button]:font-semibold",
      outside: "[&>button]:text-base-content/35",
    }),
    [],
  );

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
              <div className="group relative inline-flex items-center">
                <div className="relative inline-flex items-center overflow-hidden rounded-full border border-base-300 bg-base-300/70 text-xs text-base-content/70">
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
                    ref={dueDateTriggerRef}
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedDueDate(parseDateKeyToDate(todo.dueDate));
                      setIsDueDatePickerOpen((open) => !open);
                    }}
                    className="inline-flex items-center px-3 py-0.5 transition-all duration-200 hover:text-primary group-hover:pl-6 group-focus-within:pl-6"
                    aria-label={`Edit due date, currently ${formatDueDateBadge(todo.dueDate)}`}
                    aria-expanded={isDueDatePickerOpen}
                  >
                    Due {formatDueDateBadge(todo.dueDate)}
                  </button>
                </div>
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

      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={() => todoCollection.delete(todo.id)}
        title="Delete Todo"
        description="Are you sure you want to delete this todo? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
      />

      {typeof document !== "undefined" &&
        isDueDatePickerOpen &&
        createPortal(
          <div
            ref={dueDatePopoverRef}
            className="fixed z-[80] w-[320px] rounded-lg border border-base-300 bg-base-100 p-3 shadow-2xl"
            style={{
              top: dueDatePopoverPosition.top,
              left: dueDatePopoverPosition.left,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DayPicker
              mode="single"
              selected={selectedDueDate}
              onSelect={handleSelectDueDate}
              showOutsideDays
              weekStartsOn={1}
              className="mx-auto"
              classNames={dayPickerClassNames}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  handleSelectDueDate(undefined);
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsDueDatePickerOpen(false);
                }}
              >
                Close
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
