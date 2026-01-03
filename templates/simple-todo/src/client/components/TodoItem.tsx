import { useState, useRef, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { todoCollection } from "@/client/tanstack-db";

interface TodoItemProps {
  todo: Todo;
}

export function TodoItem({ todo }: TodoItemProps) {
  const [localTitle, setLocalTitle] = useState(todo.title);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-resize textarea to fit multi-line content without scrollbars
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [localTitle]);

  return (
    <div className="group flex items-start gap-3 p-2 rounded-md transition-colors hover:bg-primary/10 focus-within:bg-primary/10">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={(e) => {
          todoCollection.update(todo.id, (draft) => {
            draft.completed = e.target.checked;
          });
        }}
        className="checkbox checkbox-sm mt-1.5 flex-shrink-0"
        aria-label={
          todo.completed
            ? `Mark as incomplete: "${todo.title}"`
            : `Mark as complete ${todo.title}`
        }
      />

      <div className="flex-1">
        <textarea
          ref={textareaRef}
          id={`todo-inline-edit-${todo.id}`}
          value={localTitle}
          onChange={(e) => handleTitleChange(e.target.value)}
          onBlur={handleTitleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setLocalTitle(todo.title);
              e.currentTarget.blur();
            }
          }}
          disabled={todo.completed}
          className={`w-full border-none bg-transparent focus:ring-0 focus:border-none focus:outline-none shadow-none px-2 py-1 text-base leading-6 transition-all duration-200 resize-none overflow-hidden break-words ${
            todo.completed
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

      <button
        onClick={() => {
          todoCollection.delete(todo.id);
          toast("Todo deleted");
        }}
        className="btn btn-ghost btn-sm btn-square md:opacity-0 md:group-hover:opacity-100 hover:btn-error"
        aria-label={`Delete todo: ${todo.title}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
