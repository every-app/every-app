import { useQuery } from "@tanstack/react-query";
import { getChats } from "@/serverFunctions/chats";
import { MessageSquare, Plus, Trash2, Edit2, Check, X } from "lucide-react";
import type { Chat } from "@/types";
import { useState, useRef, useEffect } from "react";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

interface ChatSidebarProps {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
}

export function ChatSidebar({
  selectedChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
}: ChatSidebarProps) {
  const { data: chats, isLoading } = useQuery({
    queryKey: ["chats"],
    queryFn: () => getChats(),
  });

  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [chatToDelete, setChatToDelete] = useState<Chat | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingChatId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingChatId]);

  const handleDeleteChat = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    setChatToDelete(chat);
  };

  const handleConfirmDelete = () => {
    if (chatToDelete) {
      onDeleteChat(chatToDelete.id);
      setChatToDelete(null);
    }
  };

  const handleCancelDelete = () => {
    setChatToDelete(null);
  };

  const handleStartRename = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
  };

  const handleSaveRename = (chatId: string) => {
    if (editingTitle.trim()) {
      onRenameChat(chatId, editingTitle.trim());
    }
    setEditingChatId(null);
    setEditingTitle("");
  };

  const handleCancelRename = () => {
    setEditingChatId(null);
    setEditingTitle("");
  };

  const handleKeyDown = (e: React.KeyboardEvent, chatId: string) => {
    if (e.key === "Enter") {
      handleSaveRename(chatId);
    } else if (e.key === "Escape") {
      handleCancelRename();
    }
  };

  return (
    <div className="w-64 bg-base-200 border-r border-base-300 flex flex-col h-full">
      <div className="px-4 py-2 border-b border-base-300">
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
          target="_top"
          className="text-lg font-semibold text-base-content mb-4 block"
        >
          Every App
        </a>
      </div>

      <div className="p-4 border-b border-base-300">
        <button
          onClick={onNewChat}
          className="btn btn-primary btn-sm w-full gap-2"
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? null : chats && chats.length > 0 ? (
          <div className="p-2">
            {chats.map((chat: Chat) => (
              <div
                key={chat.id}
                onClick={() =>
                  editingChatId !== chat.id && onSelectChat(chat.id)
                }
                className={`
                  flex items-center gap-2 p-3 mb-1 rounded cursor-pointer
                  transition-colors group
                  ${
                    selectedChatId === chat.id
                      ? "bg-base-300"
                      : "hover:bg-base-300/50"
                  }
                `}
              >
                <MessageSquare size={16} className="flex-shrink-0" />
                {editingChatId === chat.id ? (
                  <div
                    className="flex-1 flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      ref={inputRef}
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, chat.id)}
                      className="flex-1 input input-xs input-bordered"
                    />
                    <button
                      onClick={() => handleSaveRename(chat.id)}
                      className="p-1 hover:bg-base-100 rounded"
                      aria-label="Save"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="p-1 hover:bg-base-100 rounded"
                      aria-label="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm">
                      {chat.title}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => handleStartRename(chat, e)}
                        className="p-1 hover:bg-base-100 rounded"
                        aria-label="Rename chat"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={(e) => handleDeleteChat(chat, e)}
                        className="p-1 hover:bg-base-100 rounded"
                        aria-label="Delete chat"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 text-center text-base-content/60 text-sm">
            No chats yet. Click "New Chat" to start.
          </div>
        )}
      </div>

      <ConfirmDeleteModal
        isOpen={chatToDelete !== null}
        chatTitle={chatToDelete?.title || ""}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
}
