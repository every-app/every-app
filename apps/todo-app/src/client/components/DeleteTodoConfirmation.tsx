import * as React from "react";
import { useState, cloneElement } from "react";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";

interface DeleteTodoConfirmationProps {
  children: React.ReactElement<{ onClick?: () => void }>;
  onConfirm: () => void;
  disabled?: boolean;
}

export function DeleteTodoConfirmation({
  children,
  onConfirm,
  disabled = false,
}: DeleteTodoConfirmationProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {cloneElement(children, {
        onClick: disabled ? undefined : () => setIsOpen(true),
      })}
      <ConfirmationModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onConfirm={onConfirm}
        title="Delete Todo"
        description="Are you sure you want to delete this todo? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
      />
    </>
  );
}
