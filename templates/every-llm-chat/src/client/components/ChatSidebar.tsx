import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  getChats,
  createChat,
  updateChat,
  deleteChat,
} from "@/serverFunctions/chats";
import { MessageSquare, Plus, Trash2, Edit2, Check, X } from "lucide-react";
import type { Chat } from "@/types";
import { useState, useRef, useEffect } from "react";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

interface ChatSidebarProps {
  activeChatId: string | null;
}

export function ChatSidebar({ activeChatId }: ChatSidebarProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  // Create chat mutation
  const createChatMutation = useMutation({
    mutationFn: (data: { id: string; title: string }) => createChat({ data }),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ["chats"] });
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      const optimisticChat: Chat = {
        id: data.id,
        userId: "",
        title: data.title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Chat[]>(["chats"], (old) => [
        optimisticChat,
        ...(old || []),
      ]);

      return { previousChats };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
    },
    onSuccess: (newChat) => {
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return [newChat];
        return old.map((chat) => (chat.id === newChat.id ? newChat : chat));
      });
    },
  });

  // Update chat mutation
  const updateChatMutation = useMutation({
    mutationFn: (data: { id: string; title: string }) => updateChat({ data }),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ["chats"] });
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return old;
        return old.map((chat) =>
          chat.id === data.id
            ? {
                ...chat,
                title: data.title,
                updatedAt: new Date().toISOString(),
              }
            : chat,
        );
      });

      return { previousChats };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
    },
    onSuccess: (updatedChat) => {
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return old;
        return old.map((chat) =>
          chat.id === updatedChat.id ? updatedChat : chat,
        );
      });
    },
  });

  // Delete chat mutation
  const deleteChatMutation = useMutation({
    mutationFn: (id: string) => deleteChat({ data: { id } }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["chats"] });
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      const remainingChats = previousChats?.filter((chat) => chat.id !== id);
      queryClient.setQueryData<Chat[]>(["chats"], remainingChats);

      // If deleting the active chat, navigate to the next one or home
      if (activeChatId === id) {
        if (remainingChats && remainingChats.length > 0) {
          navigate({
            to: "/chat/$chatId",
            params: { chatId: remainingChats[0].id },
          });
        } else {
          navigate({ to: "/" });
        }
      }

      return { previousChats };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
    },
  });

  const handleNewChat = () => {
    const chatNumber = (chats?.length ?? 0) + 1;
    const newChatId = crypto.randomUUID();
    createChatMutation.mutate({ id: newChatId, title: `Chat ${chatNumber}` });
    navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
  };

  const handleDeleteChat = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setChatToDelete(chat);
  };

  const handleConfirmDelete = () => {
    if (chatToDelete) {
      deleteChatMutation.mutate(chatToDelete.id);
      setChatToDelete(null);
    }
  };

  const handleCancelDelete = () => {
    setChatToDelete(null);
  };

  const handleStartRename = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
  };

  const handleSaveRename = (chatId: string) => {
    if (editingTitle.trim()) {
      updateChatMutation.mutate({ id: chatId, title: editingTitle.trim() });
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
          onClick={handleNewChat}
          className="btn btn-primary btn-sm w-full gap-2"
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-stable">
        {isLoading ? null : chats && chats.length > 0 ? (
          <div className="p-2">
            {chats.map((chat: Chat) => (
              <div key={chat.id}>
                {editingChatId === chat.id ? (
                  <div
                    className="flex items-center gap-2 p-3 mb-1 rounded bg-base-300"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MessageSquare size={16} className="flex-shrink-0" />
                    <div className="flex-1 flex items-center gap-1">
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
                  </div>
                ) : (
                  <Link
                    to="/chat/$chatId"
                    params={{ chatId: chat.id }}
                    className={`
                      flex items-center gap-2 p-3 mb-1 rounded cursor-pointer
                      transition-colors group
                      ${
                        activeChatId === chat.id
                          ? "bg-base-300"
                          : "hover:bg-base-300/50"
                      }
                    `}
                  >
                    <MessageSquare size={16} className="flex-shrink-0" />
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
                  </Link>
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
