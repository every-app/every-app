import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { todoCollection } from "@/client/tanstack-db";

interface CreateTodoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateTodoModal({ isOpen, onClose }: CreateTodoModalProps) {
  const [title, setTitle] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open/close modal using native dialog API
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
      setTitle("");
    }
  }, [isOpen]);

  const handleClose = () => {
    setTitle("");
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      todoCollection.insert({
        id: crypto.randomUUID(),
        title: title.trim(),
        completed: false,
      });
      toast("Todo created");
      setTitle("");
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
    >
      <div className="modal-box h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[calc(100vh-5em)] flex flex-col rounded-none sm:rounded-box">
        <h3 className="font-bold text-lg mb-4">Create Todo</h3>

        <form
          id="create-todo-form"
          onSubmit={handleSubmit}
          className="flex-1 flex flex-col min-h-0"
        >
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New todo..."
            autoFocus
            className="w-full flex-1 bg-transparent border-none outline-none resize-none text-base-content placeholder:text-base-content/50 focus:ring-0 text-base"
          />
        </form>

        <div className="modal-action flex-col gap-2 mt-auto">
          <button
            type="submit"
            form="create-todo-form"
            disabled={!title.trim()}
            className="btn btn-primary w-full"
          >
            Add Todo
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="btn btn-ghost w-full"
          >
            Cancel
          </button>
        </div>
      </div>
      {/* Backdrop - clicking closes modal */}
      <form method="dialog" className="modal-backdrop">
        <button onClick={handleClose}>close</button>
      </form>
    </dialog>
  );
}
