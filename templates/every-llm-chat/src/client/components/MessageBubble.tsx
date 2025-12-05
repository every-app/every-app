import { AuthenticatedImage } from "./AuthenticatedImage";
import type { UIMessage } from "ai";

interface MessageBubbleProps {
  message: UIMessage;
  isStreaming?: boolean;
}

export function MessageBubble({
  message,
  isStreaming = false,
}: MessageBubbleProps) {
  return (
    <div
      className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`
          max-w-[80%] p-3 rounded-lg
          ${
            message.role === "user"
              ? "bg-primary text-primary-content"
              : "bg-base-200 text-base-content"
          }
        `}
      >
        {(message.parts || []).map((part, index) => {
          if (part.type === "file" && "url" in part && part.url) {
            // If it's a data URL (optimistic UI), render directly
            if (typeof part.url === "string" && part.url.startsWith("data:")) {
              return (
                <div key={`${message.id}-file-${index}`} className="mb-2">
                  <img
                    src={part.url}
                    alt={part.filename || "Uploaded"}
                    className="max-w-full max-h-64 rounded-lg"
                  />
                </div>
              );
            }

            // Otherwise it's an R2 key, use authenticated fetching
            return (
              <div key={`${message.id}-file-${index}`} className="mb-2">
                <AuthenticatedImage
                  imageKey={part.url}
                  alt={part.filename || "Uploaded"}
                  className="max-w-full max-h-64 rounded-lg"
                />
              </div>
            );
          }

          if (part.type === "text" && "text" in part) {
            return (
              <div
                key={`${message.id}-text-${index}`}
                className="text-sm whitespace-pre-wrap"
              >
                {part.text}
                {isStreaming && index === message.parts.length - 1 && (
                  <span className="loading loading-dots loading-xs ml-1"></span>
                )}
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
