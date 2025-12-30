import { useState, useEffect, useRef } from "react";
import { Button } from "@/client/components/ui/button";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { todoCollection } from "@/client/tanstack-db";
import { generateDefaultSortKey } from "@/client/lib/fractional-indexing";

interface CreateTodoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateTodoModal({ isOpen, onClose }: CreateTodoModalProps) {
  const [title, setTitle] = useState("");
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Open/close modal using native dialog API
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
      // Focus textarea after modal opens
      const timer = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    } else {
      dialog.close();
      setTitle("");
    }
  }, [isOpen]);

  const handleClose = () => {
    if (title.trim()) {
      setShowDiscardModal(true);
    } else {
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    setShowDiscardModal(false);
    setTitle("");
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      todoCollection.insert({
        id: crypto.randomUUID(),
        title: title.trim(),
        sortKey: generateDefaultSortKey(),
        completed: false,
        completedAt: null,
      });
      setTitle("");
      onClose();
    }
  };

  return (
    <>
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
              ref={textareaRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New todo..."
              className="w-full flex-1 bg-transparent border-none outline-none resize-none text-base-content placeholder:text-base-content/50 focus:ring-0 text-base"
            />
          </form>

          <div className="modal-action flex-col gap-2 mt-auto">
            <Button
              type="submit"
              form="create-todo-form"
              disabled={!title.trim()}
              variant="primary"
              className="w-full"
            >
              Add Todo
            </Button>
            <Button
              type="button"
              onClick={handleClose}
              variant="ghost"
              className="w-full"
            >
              Cancel
            </Button>
          </div>
        </div>
        {/* Backdrop - clicking closes modal */}
        <form method="dialog" className="modal-backdrop">
          <button onClick={handleClose}>close</button>
        </form>
      </dialog>

      <ConfirmationModal
        isOpen={showDiscardModal}
        onClose={() => setShowDiscardModal(false)}
        onConfirm={handleConfirmDiscard}
        title="Discard changes?"
        description="You have unsaved changes. Are you sure you want to discard them?"
        confirmText="Discard"
        cancelText="Keep editing"
        variant="warning"
      />
    </>
  );
}
