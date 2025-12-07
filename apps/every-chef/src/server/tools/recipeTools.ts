import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for the tool input - what the AI sends when it wants to save a recipe
 */
const promptUserWithRecipeUpdateInputSchema = z.object({
  title: z.string().describe("The title of the recipe"),
  content: z.string().describe("The full recipe content in markdown format"),
});

export type PromptUserWithRecipeUpdateInput = z.infer<
  typeof promptUserWithRecipeUpdateInputSchema
>;

/**
 * Schema for the tool output - what the user decides
 */
const promptUserWithRecipeUpdateOutputSchema = z.object({
  action: z
    .enum(["create", "update", "ignore"])
    .describe("The action the user chose"),
  recipeId: z
    .string()
    .optional()
    .describe("The recipe ID to update (only for update action)"),
});

export type PromptUserWithRecipeUpdateOutput = z.infer<
  typeof promptUserWithRecipeUpdateOutputSchema
>;

/**
 * Tool that prompts the user to decide what to do with a recipe suggestion.
 *
 * This tool does NOT have an execute function - it's a "human-in-the-loop" tool
 * that forwards the request to the client for user interaction.
 *
 * The client renders a UI with options:
 * - Create New Recipe
 * - Update Existing Recipe (with dropdown of active recipes)
 * - Ignore (propose other ideas)
 *
 * The user's choice is sent back via addToolOutput() and the result
 * is returned to the AI to continue the conversation.
 */
const promptUserWithRecipeUpdate = tool({
  description: `Prompt the user to decide whether to save a recipe. Use this tool when:
1. You have suggested a complete recipe and want to offer to save it
2. The user has asked you to save, create, or update a recipe
3. You have refined or modified a recipe based on user feedback

The tool will show the user options to:
- Create a new recipe
- Update an existing active recipe in this chat
- Ignore and get other suggestions

Wait for the user's response before proceeding.`,
  inputSchema: promptUserWithRecipeUpdateInputSchema,
  // No execute function - this makes it a client-side tool
});

/**
 * The tools object to pass to streamText
 */
export const recipeTools = {
  promptUserWithRecipeUpdate,
};

type RecipeTools = typeof recipeTools;
