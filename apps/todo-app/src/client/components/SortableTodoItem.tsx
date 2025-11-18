import { useState, useRef, useEffect } from "react";
import { Checkbox } from "@/client/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/client/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";
import { Edit, Trash2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { DeleteTodoConfirmation } from "@/client/components/DeleteTodoConfirmation";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { todoCollection } from "@/client/tanstack-db";

interface SortableTodoItemProps {
  todo: Todo;
  editingTodoId: string | null;
  focusedActionId: string | null;
  setEditingTodoId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedActionId: React.Dispatch<React.SetStateAction<string | null>>;
  isDraggable?: boolean;
}

export function SortableTodoItem({
  todo,
  editingTodoId,
  focusedActionId,
  setEditingTodoId,
  setFocusedActionId,
  isDraggable = true,
}: SortableTodoItemProps) {
  const isMobile = useIsMobile();
  const [localTitle, setLocalTitle] = useState(todo.title);
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
    transform: CSS.Transform.toString(transform),
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

  const handleTextClick = () => {
    if (todo.completed) return;
    handleClickEditTodo();
  };

  const handleTextKeyDown = (e: React.KeyboardEvent) => {
    if (todo.completed) return;
    // Enter or Space to start editing
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClickEditTodo();
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  // Auto-resize textarea when editing and content changes
  useEffect(() => {
    if (editingTodoId === todo.id) {
      adjustTextareaHeight();
    }
  }, [editingTodoId, localTitle, todo.id]);

  const todoItem = (
    <div
      ref={setNodeRef}
      style={style}
      {...(isDraggable ? attributes : {})}
      {...(isDraggable ? listeners : {})}
      className={`flex items-center gap-3 p-2 rounded-md transition-colors ${
        isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      } ${isDragging ? "opacity-50" : ""} ${
        editingTodoId === todo.id ? "bg-blue-50" : "hover:bg-gray-100"
      }`}
    >
      <Checkbox
        checked={todo.completed}
        onCheckedChange={(checked) => {
          todoCollection.update(todo.id, (draft) => {
            draft.completed = Boolean(checked);
            draft.completedAt = new Date().toString();
          });
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none transition-all duration-200 hover:ring-2 hover:ring-gray-300 hover:ring-offset-1"
        aria-label={
          todo.completed
            ? `Mark as incomplete: "${todo.title}"`
            : `Mark as complete ${todo.title}`
        }
      />

      <div className="flex-1">
        {editingTodoId === todo.id ? (
          <textarea
            ref={textareaRef}
            id={formatInlineEditId(todo.id)}
            value={localTitle}
            onChange={(e) => handleTitleChange(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onPointerDown={(e) => e.stopPropagation()}
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
            className="w-full border-none bg-transparent focus:ring-0 focus:border-none focus:outline-none shadow-none px-2 py-1 text-base leading-6 transition-all duration-200 cursor-text focus:cursor-text focus:bg-blue-50 resize-none overflow-hidden"
            rows={1}
            autoFocus
            aria-label={`Edit todo: ${todo.title}`}
          />
        ) : (
          <div
            role="button"
            tabIndex={todo.completed ? -1 : 0}
            onClick={handleTextClick}
            onKeyDown={handleTextKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            className={`px-2 py-1 text-base leading-6 rounded transition-all duration-200 break-words ${
              todo.completed
                ? "line-through text-gray-500 cursor-default"
                : "cursor-text hover:bg-gray-50 focus:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-200"
            }`}
            aria-label={
              todo.completed
                ? `Completed todo: ${todo.title}`
                : `Edit todo: ${todo.title}`
            }
          >
            {todo.title}
          </div>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          onFocus={() => setFocusedActionId(todo.id)}
          onBlur={() => setFocusedActionId(null)}
          onPointerDown={(e) => e.stopPropagation()}
          className={`rounded transition-all duration-200 hover:bg-gray-200 opacity-100 p-1 w-auto h-auto focus:opacity-100 focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:p-1 focus:w-auto focus:h-auto`}
          aria-label="More actions"
        >
          <MoreHorizontal
            className={`h-4 w-4 text-gray-600 ${
              isMobile || focusedActionId === todo.id
                ? "opacity-100 w-auto h-auto"
                : "opacity-0 w-0 h-0 p-0"
            }`}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (editingTodoId === todo.id) {
              event.preventDefault();
            }
          }}
        >
          <DropdownMenuItem
            className="focus:bg-blue-50 focus:text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={todo.completed ? undefined : handleClickEditTodo}
            disabled={todo.completed}
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit {todo.completed && "(Disabled)"}
          </DropdownMenuItem>
          <DeleteTodoConfirmation
            onConfirm={() => todoCollection.delete(todo.id)}
          >
            <DropdownMenuItem
              onSelect={(e) => e.preventDefault()}
              className="text-red-600 focus:text-red-700 focus:bg-red-50"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DeleteTodoConfirmation>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return isMobile ? (
    todoItem
  ) : (
    <ContextMenu>
      <ContextMenuTrigger asChild>{todoItem}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={todo.completed ? undefined : handleClickEditTodo}
          disabled={todo.completed}
          className="disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Edit className="h-4 w-4 mr-2" />
          Edit {todo.completed && "(Disabled)"}
        </ContextMenuItem>
        <DeleteTodoConfirmation
          onConfirm={() => todoCollection.delete(todo.id)}
        >
          <ContextMenuItem
            onSelect={(e) => e.preventDefault()}
            className="text-red-600 focus:text-red-700 focus:bg-red-50"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </ContextMenuItem>
        </DeleteTodoConfirmation>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function formatInlineEditId(id: string) {
  return `todo-inline-edit-id-${id}`;
}
