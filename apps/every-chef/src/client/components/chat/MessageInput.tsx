import { useState } from "react";
import { Send, Square } from "lucide-react";

interface MessageInputProps {
  onSendMessage: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
}

export function MessageInput({
  onSendMessage,
  disabled = false,
  isStreaming = false,
  onStop,
  placeholder = "Ask anything about cooking...",
}: MessageInputProps) {
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled && !isStreaming) {
      onSendMessage(message.trim());
      setMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const isDisabled = disabled || isStreaming;

  return (
    <div className="bg-base-200 p-4 pb-safe">
      <div className="max-w-2xl mx-auto">
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 bg-base-100 border border-base-300 rounded-xl p-2 shadow-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 transition-all"
        >
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "AI is responding..." : placeholder}
            disabled={isDisabled}
            className="flex-1 resize-none min-h-[40px] max-h-[120px] bg-transparent border-none focus:outline-none placeholder:text-base-content/40 text-base md:text-sm px-2 py-2"
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="btn btn-error btn-sm btn-circle"
              aria-label="Stop generating"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!message.trim() || isDisabled}
              className="btn btn-primary btn-sm btn-circle"
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
