import { useState } from "react";
import { Input } from "@/client/components/ui/input";
import { Button } from "@/client/components/ui/button";
import { generateDefaultSortKey } from "@/client/lib/fractional-indexing";
import { todoCollection } from "@/client/tanstack-db";

export function MobileTodoInput() {
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");

  return (
    <div className="bg-base-200 p-4 z-40">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newTodoTitle.trim()) {
            todoCollection.insert({
              id: crypto.randomUUID(),
              title: newTodoTitle.trim(),
              sortKey: generateDefaultSortKey(),
              completed: false,
              completedAt: null,
            });
            setNewTodoTitle("");
          }
        }}
        className="flex gap-2 max-w-md mx-auto"
      >
        <Input
          name="title"
          placeholder="New todo..."
          value={newTodoTitle}
          onChange={(e) => setNewTodoTitle(e.target.value)}
          className="focus:border-primary focus:bg-primary/10 transition-all duration-200"
          aria-label="Enter new todo"
        />
        <Button
          type="submit"
          disabled={!newTodoTitle.trim()}
          variant="primary"
          aria-label="Add new todo"
        >
          Add
        </Button>
      </form>
    </div>
  );
}

/** Invisible spacer to reserve the same height as MobileTodoInput when it's not shown */
export function MobileTodoInputSpacer() {
  return <div className="h-[72px]" aria-hidden="true" />;
}
