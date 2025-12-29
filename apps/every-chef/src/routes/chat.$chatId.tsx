import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ChatWindow } from "@/client/components/chat/ChatWindow";
import { MessageInput } from "@/client/components/chat/MessageInput";
import { ActiveRecipesPanel } from "@/client/components/chat/ActiveRecipesPanel";
import { useChatWithAuth } from "@/client/hooks/useChatWithAuth";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { useSortedChats, useCreateChat } from "@/client/hooks/useChats";
import { getMessages } from "@/serverFunctions/chats";
import { createRecipe, updateRecipe } from "@/serverFunctions/recipes";
import { saveToolOutputAction } from "@/client/actions/saveToolOutput";
import {
  chatActiveRecipesCollection,
  recipesCollection,
} from "@/client/tanstack-db";
import type { UIMessage } from "ai";
import type { PromptUserWithRecipeUpdateInput } from "@/server/tools/recipeTools";

export const Route = createFileRoute("/chat/$chatId")({
  component: ChatPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { pendingMessage?: string } => {
    return {
      pendingMessage:
        typeof search.pendingMessage === "string"
          ? search.pendingMessage
          : undefined,
    };
  },
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const { pendingMessage } = Route.useSearch();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const pendingMessageSentRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chats = useSortedChats();
  const createNewChat = useCreateChat();
  const chat = chats.find((c) => c.id === chatId);

  // Redirect to home if chat doesn't exist
  useEffect(() => {
    if (chats.length > 0 && !chat) {
      navigate({ to: "/" });
    }
  }, [chats, chat, navigate]);

  // Get active recipes for this chat
  const { data: allActiveRecipes } = useLiveQuery((q) =>
    q.from({ activeRecipe: chatActiveRecipesCollection }),
  );
  const { data: allRecipes } = useLiveQuery((q) =>
    q.from({ recipe: recipesCollection }),
  );

  // Filter and join active recipes for current chat
  const activeRecipes = (allActiveRecipes ?? [])
    .filter((ar) => ar.chatId === chatId)
    .map((ar) => {
      const recipe = (allRecipes ?? []).find((r) => r.id === ar.recipeId);
      return recipe ? { ...ar, recipe } : null;
    })
    .filter((ar) => ar !== null);

  const isInCookingMode = activeRecipes.length > 0;

  const removeActiveRecipe = (recipeId: string) => {
    const activeRecipe = (allActiveRecipes ?? []).find(
      (ar) => ar.chatId === chatId && ar.recipeId === recipeId,
    );
    if (activeRecipe) {
      chatActiveRecipesCollection.delete(activeRecipe.id);
      toast("Recipe removed");
    }
  };

  const queryClient = useQueryClient();

  const { data: persistedMessages, isLoading: isLoadingMessages } = useQuery({
    queryKey: ["messages", chatId],
    queryFn: () => getMessages({ data: { chatId } }),
    enabled: !!chatId,
  });

  const initialMessages = (persistedMessages ?? []) as UIMessage[];

  // Optimistically update the messages cache
  const addMessageToCache = useCallback(
    (message: UIMessage) => {
      queryClient.setQueryData(
        ["messages", chatId],
        (oldMessages: UIMessage[] | undefined) => {
          if (!oldMessages) return [message];
          // Avoid duplicates by checking if message already exists
          if (oldMessages.some((m) => m.id === message.id)) {
            return oldMessages;
          }
          return [...oldMessages, message];
        },
      );
    },
    [queryClient, chatId],
  );

  const {
    streamingMessages,
    handleSendMessage,
    isStreaming,
    stop,
    addToolOutput,
  } = useChatWithAuth({
    selectedChatId: chatId,
    initialMessages,
    onUserMessage: addMessageToCache,
    onAssistantMessage: addMessageToCache,
  });

  // Scroll to bottom when messages load or when streaming new content
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [initialMessages, streamingMessages]);

  // Auto-send pending message from index page navigation
  useEffect(() => {
    if (
      pendingMessage &&
      !pendingMessageSentRef.current &&
      !isLoadingMessages
    ) {
      pendingMessageSentRef.current = true;
      handleSendMessage(pendingMessage);
      // Clear the search param from URL
      navigate({ to: "/chat/$chatId", params: { chatId }, replace: true });
    }
  }, [pendingMessage, isLoadingMessages, handleSendMessage, navigate, chatId]);

  const activeRecipesList = activeRecipes.map((ar) => ar.recipe);

  // Store pending tool inputs for when user makes a decision
  // We need to extract the input from messages when handling tool actions
  const getToolInput = useCallback(
    (toolCallId: string): PromptUserWithRecipeUpdateInput | null => {
      const messages = (
        streamingMessages.length > 0 ? streamingMessages : initialMessages
      ) as UIMessage[];

      for (const message of messages) {
        for (const part of message.parts) {
          // Check for tool invocation parts
          // AI SDK 5 uses typed tool names like "tool-promptUserWithRecipeUpdate"
          // Persisted format uses "tool-invocation" with toolName property
          const partType = part.type as string;
          const p = part as Record<string, unknown>;

          // Check for our specific tool
          const isOurTool =
            partType === "tool-promptUserWithRecipeUpdate" ||
            (partType === "tool-invocation" &&
              p.toolName === "promptUserWithRecipeUpdate");

          if (
            isOurTool &&
            "toolCallId" in part &&
            (part as { toolCallId: string }).toolCallId === toolCallId &&
            "input" in part
          ) {
            return (part as { input: PromptUserWithRecipeUpdateInput }).input;
          }
        }
      }
      return null;
    },
    [streamingMessages, initialMessages],
  );

  // Handle tool actions (create/update/ignore)
  const handleToolAction = useCallback(
    async (
      toolCallId: string,
      action: "create" | "update" | "ignore",
      recipeId?: string,
    ) => {
      const toolInput = getToolInput(toolCallId);

      if (!toolInput) {
        toast.error("Could not find recipe data");
        return;
      }

      try {
        if (action === "create") {
          // Create a new recipe
          const newRecipeId = crypto.randomUUID();
          await createRecipe({
            data: {
              id: newRecipeId,
              title: toolInput.title,
              content: toolInput.content,
            },
          });

          // Add to active recipes for this chat
          const activeRecipeId = crypto.randomUUID();
          chatActiveRecipesCollection.insert({
            id: activeRecipeId,
            chatId,
            recipeId: newRecipeId,
            activatedAt: new Date().toISOString(),
          });

          // Invalidate recipes query
          await queryClient.invalidateQueries({ queryKey: ["recipes"] });

          toast.success(`Created "${toolInput.title}"`);

          const output = { action: "create" as const };

          // Persist the tool output to database
          await saveToolOutputAction({
            toolCallId,
            output,
          });

          // Send tool output to streaming state (optimistic UI update)
          addToolOutput({
            tool: "promptUserWithRecipeUpdate",
            toolCallId,
            output,
          });
        } else if (action === "update" && recipeId) {
          // Update existing recipe
          await updateRecipe({
            data: {
              id: recipeId,
              title: toolInput.title,
              content: toolInput.content,
            },
          });

          // Invalidate recipes query
          await queryClient.invalidateQueries({ queryKey: ["recipes"] });

          toast.success(`Updated recipe`);

          const output = { action: "update" as const, recipeId };

          // Persist the tool output to database
          await saveToolOutputAction({
            toolCallId,
            output,
          });

          // Send tool output to streaming state (optimistic UI update)
          addToolOutput({
            tool: "promptUserWithRecipeUpdate",
            toolCallId,
            output,
          });
        } else if (action === "ignore") {
          const output = { action: "ignore" as const };

          // Persist the tool output to database
          await saveToolOutputAction({
            toolCallId,
            output,
          });

          // Send tool output to streaming state (optimistic UI update)
          addToolOutput({
            tool: "promptUserWithRecipeUpdate",
            toolCallId,
            output: { action: "ignore" },
          });

          toast("Recipe suggestion dismissed");
        }

        // Invalidate messages query so the decision is persisted on refresh
        await queryClient.invalidateQueries({ queryKey: ["messages", chatId] });
      } catch (error) {
        console.error("Failed to handle tool action:", error);
        toast.error("Failed to save recipe");
      }
    },
    [chatId, getToolInput, addToolOutput, queryClient],
  );

  // Don't render chat until messages are loaded
  if (isLoadingMessages) {
    return <div className="flex flex-col h-full bg-base-200" />;
  }

  return (
    <div className="flex flex-col h-full bg-base-200">
      {/* Fixed header - only show on desktop, mobile uses drawer navbar */}
      {!isMobile && (
        <div className="flex-shrink-0 border-b border-base-300 bg-base-200">
          <div className="max-w-2xl mx-auto px-4 py-4">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="page-title">Chef</h1>
                <p className="text-base-content/70 mt-1">
                  Your personal cooking assistant
                </p>
              </div>
              <button
                onClick={createNewChat}
                className="btn btn-primary btn-sm gap-1"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active recipes panel (below header, above chat) */}
      <ActiveRecipesPanel
        recipes={activeRecipesList}
        onRemoveRecipe={removeActiveRecipe}
      />

      {/* Scrollable chat area */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto scrollbar-stable min-h-0"
      >
        <ChatWindow
          messages={
            (streamingMessages.length > 0
              ? streamingMessages
              : initialMessages) as UIMessage[]
          }
          isStreaming={isStreaming}
          activeRecipes={activeRecipesList}
          onToolAction={handleToolAction}
        />
      </div>

      {/* Fixed input at bottom */}
      <div className="flex-shrink-0">
        <MessageInput
          onSendMessage={handleSendMessage}
          disabled={isStreaming}
          isStreaming={isStreaming}
          onStop={stop}
          placeholder={
            isInCookingMode
              ? "Ask about your recipe..."
              : "What would you like to cook?"
          }
        />
      </div>
    </div>
  );
}
