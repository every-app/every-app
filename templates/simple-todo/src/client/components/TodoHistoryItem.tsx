import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { todoCollection } from "@/client/tanstack-db";

interface HistoryItemProps {
  todo: Todo;
}

export function HistoryItem({ todo }: HistoryItemProps) {
  return (
    <div className="group flex items-center gap-3 p-2 rounded-md hover:bg-base-200 transition-colors">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={(e) => {
          todoCollection.update(todo.id, (draft) => {
            draft.completed = e.target.checked;
          });
        }}
        className="checkbox checkbox-sm"
        aria-label={`Mark "${todo.title}" as incomplete`}
      />

      <span className="flex-1 text-sm line-through text-base-content/50">
        {todo.title}
      </span>

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
