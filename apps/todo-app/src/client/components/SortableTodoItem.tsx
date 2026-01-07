import { useState, useRef, useEffect } from "react";
import { Checkbox } from "@/client/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { MoreHorizontal, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { todoCollection } from "@/client/tanstack-db";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const handleTitleChange = (newTitle: string) => {
    if (todo.completed) return;
    setLocalTitle(newTitle);
  };

  const handleTitleSave = () => {
    const currentValue = localTitle.trim();

    if (todo.completed) {
      toast.error("Cannot edit completed todos. Unmark as completed first.");
      setLocalTitle(todo.title);
      return;
    }

    if (currentValue !== todo.title) {
      if (currentValue) {
        todoCollection.update(todo.id, (draft) => {
          draft.title = currentValue;
        });
      } else {
        toast.error("Todo title cannot be empty");
        setLocalTitle(todo.title);
      }
    }
  };

  const handleInputFocus = () => {
    if (todo.completed) return;
    setEditingTodoId(todo.id);
  };

  const handleInputBlur = () => {
    if (todo.completed) return;
    setEditingTodoId(null);
    handleTitleSave();
  };

  const handleClickEditTodo = () => {
    if (todo.completed) {
      toast.error("Cannot edit completed todos. Unmark as completed first.");
      return;
    }

    setEditingTodoId(todo.id);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const textLength = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(textLength, textLength);
        adjustTextareaHeight();
      }
    });
  };

  // Auto-resize textarea to fit multi-line content without scrollbars
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Store current scroll position to prevent page jumping
    const scrollTop = window.scrollY;

    // Reset height to auto to get the correct scrollHeight
    // Use minHeight instead of height to avoid collapsing during transition
    textarea.style.minHeight = "0";
    textarea.style.height = "auto";

    // Force a reflow to ensure scrollHeight is recalculated
    // This is necessary because some browsers batch style changes
    void textarea.offsetHeight;

    const newHeight = Math.max(textarea.scrollHeight, 24); // Minimum height of 24px (one line)
    textarea.style.height = `${newHeight}px`;
    textarea.style.minHeight = "";

    // Restore scroll position
    window.scrollTo({ top: scrollTop });
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [localTitle]);

  // Also adjust on window resize (handles font scaling, zoom changes)
  useEffect(() => {
    window.addEventListener("resize", adjustTextareaHeight);
    return () => window.removeEventListener("resize", adjustTextareaHeight);
  }, []);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isDraggable ? attributes : {})}
      {...(isDraggable ? listeners : {})}
      className={`flex items-start gap-3 p-2 rounded-md border ${
        isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      } ${
        isDragging
          ? "z-50 bg-base-200 shadow-lg border-base-300"
          : editingTodoId === todo.id
            ? "border-base-300 bg-base-300/50"
            : "border-transparent hover:bg-base-200"
      }`}
    >
      {/* before:absolute before:inset-[-8px] creates an invisible hit area extending 8px beyond the checkbox */}
      <Checkbox
        checked={todo.completed}
        onCheckedChange={(checked) => {
          onToggleComplete?.(todo.id, Boolean(checked));
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="mt-1.5 flex-shrink-0 relative before:absolute before:inset-[-8px] before:content-['']"
        aria-label={
          todo.completed
            ? `Mark as incomplete: "${todo.title}"`
            : `Mark as complete ${todo.title}`
        }
      />

      <div className="flex-1">
        <textarea
          ref={textareaRef}
          id={formatInlineEditId(todo.id)}
          value={localTitle}
          onChange={(e) => handleTitleChange(e.target.value)}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onPointerDown={(e) => {
            // Only stop propagation when editing to allow drag gestures when not focused
            if (editingTodoId === todo.id) {
              e.stopPropagation();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              setEditingTodoId(null);
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setLocalTitle(todo.title);
              setEditingTodoId(null);
              e.currentTarget.blur();
            }
          }}
          disabled={todo.completed}
          className={`w-full border-none bg-transparent focus:ring-0 focus:border-none focus:outline-none shadow-none px-2 py-1 text-base leading-6 resize-none overflow-hidden break-words ${
            isDragging
              ? "!cursor-grabbing"
              : todo.completed
                ? "line-through text-base-content/50 cursor-default"
                : "cursor-text"
          }`}
          rows={1}
          aria-label={
            todo.completed
              ? `Completed todo: ${todo.title}`
              : `Edit todo: ${todo.title}`
          }
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          onPointerDown={(e) => e.stopPropagation()}
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
    </div>
  );
}

function formatInlineEditId(id: string) {
  return `todo-inline-edit-id-${id}`;
}
