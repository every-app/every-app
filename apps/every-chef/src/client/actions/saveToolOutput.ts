import { saveToolOutput } from "@/serverFunctions/chats";

type SaveToolOutputParams = {
  toolCallId: string;
  output: Record<string, unknown>;
};

/**
 * Action to save a tool output (user's decision) to the database.
 *
 * Note: The optimistic UI update happens through addToolOutput from useChat.
 * This action persists the decision to the database so it shows up
 * when the user refreshes or returns to the chat.
 */
export async function saveToolOutputAction(
  params: SaveToolOutputParams,
): Promise<void> {
  await saveToolOutput({
    data: {
      toolCallId: params.toolCallId,
      output: params.output,
    },
  });
}
