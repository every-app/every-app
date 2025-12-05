import { createFileRoute } from "@tanstack/react-router";
import { ChatSidebar } from "@/client/components/ChatSidebar";
import { ChatWindow } from "@/client/components/ChatWindow";
import { useChatManagement } from "@/client/hooks/useChatManagement";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const {
    selectedChatId,
    selectChat,
    createNewChat,
    removeChatAndSelectNext,
    renameChat,
  } = useChatManagement();

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <ChatSidebar
        selectedChatId={selectedChatId}
        onSelectChat={selectChat}
        onNewChat={createNewChat}
        onDeleteChat={removeChatAndSelectNext}
        onRenameChat={renameChat}
      />

      <div className="flex-1 flex flex-col">
        {selectedChatId ? (
          <ChatWindow chatId={selectedChatId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-base-content/60">
            <div className="text-center">
              <p className="text-lg mb-2">No chat selected</p>
              <p className="text-sm">Create a new chat to get started</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
