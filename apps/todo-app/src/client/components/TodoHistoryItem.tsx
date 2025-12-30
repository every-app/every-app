import { useState } from "react";
import { Checkbox } from "@/client/components/ui/checkbox";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { todoCollection } from "@/client/tanstack-db";

interface HistoryItemProps {
  todo: Todo;
}

export function HistoryItem({ todo }: HistoryItemProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  return (
    <div className="group flex items-center gap-3 p-2 rounded-md border border-transparent hover:border-base-300 hover:bg-base-300/50 transition-all">
      <Checkbox
        checked={todo.completed}
        onCheckedChange={(checked) => {
          todoCollection.update(todo.id, (draft) => {
            draft.completed = Boolean(checked);
            if (!checked) {
              draft.completedAt = null;
            }
          });
        }}
        className="focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none transition-all duration-200 hover:ring-2 hover:ring-gray-300 hover:ring-offset-1"
        aria-label={`Mark "${todo.title}" as incomplete`}
      />

      <span className="flex-1 text-sm line-through text-gray-500">
        {todo.title}
      </span>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowDeleteModal(true)}
        className="md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:bg-red-50 hover:text-red-600"
        aria-label={`Delete todo: ${todo.title}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

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
