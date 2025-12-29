import { useState } from "react";
import { Input } from "@/client/components/ui/input";
import { Button } from "@/client/components/ui/button";
import { generateDefaultSortKey } from "@/client/lib/fractional-indexing";
import { todoCollection } from "@/client/tanstack-db";

export function MobileTodoInput() {
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");
  const [isFocused, setIsFocused] = useState(false);

  return (
    <div
      className="fixed left-0 right-0 z-40 bg-base-200 px-4 py-2 transition-[bottom] duration-200"
      style={{ bottom: isFocused ? "8px" : "84px" }}
    >
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
        className="flex gap-2"
      >
        <Input
          name="title"
          placeholder="New todo..."
          value={newTodoTitle}
          onChange={(e) => setNewTodoTitle(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
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
