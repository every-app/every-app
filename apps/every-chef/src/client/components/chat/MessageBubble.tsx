import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { RecipeUpdatePrompt } from "./RecipeUpdatePrompt";
import type { Recipe } from "@/db/schema";
import type {
  PromptUserWithRecipeUpdateInput,
  PromptUserWithRecipeUpdateOutput,
} from "@/server/tools/recipeTools";

interface MessageBubbleProps {
  message: UIMessage;
  isStreaming?: boolean;
  activeRecipes?: Recipe[];
  onToolAction?: (
    toolCallId: string,
    action: "create" | "update" | "ignore",
    recipeId?: string,
  ) => void;
}

// Helper to check if a part is a tool part for our recipe tool
// AI SDK 5 uses "tool-{toolName}" format for streaming tool parts
// Our persisted format uses "tool-invocation" with toolName property
function isRecipeToolPart(part: unknown): part is {
  type: string;
  toolCallId: string;
  state: string;
  input: PromptUserWithRecipeUpdateInput;
  output?: PromptUserWithRecipeUpdateOutput;
  toolName?: string;
} {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;

  // Check for AI SDK 5 streaming format: type is "tool-promptUserWithRecipeUpdate"
  if (p.type === "tool-promptUserWithRecipeUpdate" && "toolCallId" in p) {
    return true;
  }

  // Check for persisted format: type is "tool-invocation" with toolName
  if (
    p.type === "tool-invocation" &&
    p.toolName === "promptUserWithRecipeUpdate" &&
    "toolCallId" in p
  ) {
    return true;
  }

  return false;
}

// Helper to check if a part is any tool part
function isToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  const type = p.type as string;

  // AI SDK 5 format: starts with "tool-"
  if (typeof type === "string" && type.startsWith("tool-")) {
    return true;
  }

  // Persisted format
  if (type === "tool-invocation") {
    return true;
  }

  return false;
}

export function MessageBubble({
  message,
  isStreaming = false,
  activeRecipes = [],
  onToolAction,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const parts = message.parts || [];

  // Check if this message has any non-empty text parts
  const hasTextContent = parts.some(
    (part) =>
      part.type === "text" && "text" in part && (part.text as string).trim(),
  );

  // Check if this message has tool parts
  const hasToolParts = parts.some((part) => isToolPart(part));

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] space-y-2">
        {/* Text content in assistant bubble */}
        {hasTextContent && (
          <div
            className={isUser ? "chat-message-user" : "chat-message-assistant"}
          >
            {parts.map((part, index) => {
              if (part.type === "text" && "text" in part) {
                const text = part.text as string;
                if (!text.trim()) return null;

                if (isUser) {
                  return (
                    <div
                      key={`${message.id}-text-${index}`}
                      className="text-sm whitespace-pre-wrap"
                    >
                      {text}
                    </div>
                  );
                }

                return (
                  <div key={`${message.id}-text-${index}`} className="text-sm">
                    <Streamdown>{text}</Streamdown>
                    {isStreaming &&
                      index === parts.length - 1 &&
                      !hasToolParts && (
                        <span className="loading loading-dots loading-xs ml-1 inline-block"></span>
                      )}
                  </div>
                );
              }

              if (part.type === "file" && "url" in part && part.url) {
                return (
                  <div key={`${message.id}-file-${index}`} className="mb-2">
                    <div className="text-xs text-base-content/50">[Image]</div>
                  </div>
                );
              }

              return null;
            })}
          </div>
        )}

        {/* Tool parts in assistant bubble */}
        {hasToolParts && (
          <div className="chat-message-assistant">
            {parts.map((part, index) => {
              // Handle our recipe tool
              if (isRecipeToolPart(part)) {
                const state = part.state;
                const input = part.input;
                const output = part.output;

                // Map AI SDK 5 states to our completion check
                // AI SDK 5 states: input-streaming, input-available, output-available, output-error
                // Persisted states: partial-call, call, partial-result, result
                const isCompleted =
                  state === "output-available" ||
                  (state === "result" && output !== undefined);

                // Show loading state while input is streaming
                if (state === "input-streaming") {
                  return (
                    <div
                      key={`${message.id}-tool-${part.toolCallId}`}
                      className="flex items-center gap-2 text-sm text-base-content/70"
                    >
                      <span className="loading loading-spinner loading-xs"></span>
                      Preparing recipe...
                    </div>
                  );
                }

                // Show the prompt when input is available
                if (
                  state === "input-available" ||
                  state === "call" ||
                  isCompleted
                ) {
                  return (
                    <RecipeUpdatePrompt
                      key={`${message.id}-tool-${part.toolCallId}`}
                      toolCallId={part.toolCallId}
                      input={input}
                      activeRecipes={activeRecipes}
                      onAction={(action, recipeId) => {
                        if (onToolAction) {
                          onToolAction(part.toolCallId, action, recipeId);
                        }
                      }}
                      isCompleted={isCompleted}
                      completedAction={output?.action}
                      completedRecipeId={output?.recipeId}
                    />
                  );
                }

                return null;
              }

              // Generic fallback for other tool parts
              if (isToolPart(part)) {
                const p = part as Record<string, unknown>;
                const toolCallId = p.toolCallId as string;
                const type = p.type as string;
                const toolName = p.toolName || type.replace("tool-", "");

                return (
                  <div
                    key={`${message.id}-tool-${toolCallId || index}`}
                    className="text-xs text-base-content/50 my-2"
                  >
                    [Tool: {toolName as string}]
                  </div>
                );
              }

              return null;
            })}
          </div>
        )}

        {/* Show loading when message has no content yet */}
        {!hasTextContent && !hasToolParts && isStreaming && (
          <div className="chat-message-assistant">
            <span className="loading loading-dots loading-sm"></span>
          </div>
        )}
      </div>
    </div>
  );
}
