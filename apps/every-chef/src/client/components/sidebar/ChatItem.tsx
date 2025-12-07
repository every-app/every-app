import { Link } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { chatsCollection } from "@/client/tanstack-db";
import type { Chat } from "@/db/schema";

interface ChatItemProps {
  chat: Chat;
  isActive: boolean;
  onNavigate?: () => void;
}

export function ChatItem({ chat, isActive, onNavigate }: ChatItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== chat.title) {
      chatsCollection.update(chat.id, (draft) => {
        draft.title = trimmedValue;
        draft.updatedAt = new Date().toISOString();
      });
    } else {
      setEditValue(chat.title);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(chat.title);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  const handleDelete = () => {
    chatsCollection.delete(chat.id);
    toast("Chat deleted");
  };

  const handleRename = () => {
    setIsEditing(true);
    // Close dropdown by blurring active element
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  if (isEditing) {
    return (
      <div className="relative flex items-center gap-2 py-1 px-2 pr-4">
        {isActive && (
          <div className="absolute -left-4 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          className="flex-1 min-w-0 text-sm bg-base-200 border border-base-300 rounded px-2 py-1 focus:outline-none focus:border-primary"
        />
        <button
          onClick={handleSave}
          className="btn btn-primary btn-xs btn-square flex-shrink-0"
          aria-label="Save"
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <Link
      to="/chat/$chatId"
      params={{ chatId: chat.id }}
      onClick={onNavigate}
      className={`group relative flex items-center gap-2 py-2 px-2 text-sm rounded-lg transition-colors ${
        isActive
          ? "text-base-content font-medium"
          : "text-base-content/70 hover:text-base-content hover:bg-base-200"
      }`}
    >
      {isActive && (
        <div className="absolute -left-4 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
      )}
      <span className="truncate flex-1">{chat.title}</span>
      <div
        className="dropdown dropdown-end opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.preventDefault()}
      >
        <div
          tabIndex={0}
          role="button"
          className="btn btn-ghost btn-xs btn-square"
          aria-label="Chat options"
        >
          <MoreHorizontal className="h-4 w-4" />
        </div>
        <ul
          tabIndex={0}
          className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 p-2 shadow-lg border border-base-300"
        >
          <li>
            <button onClick={handleRename} className="flex items-center gap-2">
              <Pencil className="h-4 w-4" />
              Rename
            </button>
          </li>
          <li>
            <button
              onClick={handleDelete}
              className="flex items-center gap-2 text-error hover:bg-error/10"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </li>
        </ul>
      </div>
    </Link>
  );
}
