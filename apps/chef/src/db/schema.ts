import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";

// === Enums (as const arrays for SQLite) ===

export const messageRoles = ["user", "assistant"] as const;
export type MessageRole = (typeof messageRoles)[number];

export const messagePartTypes = ["text", "image", "tool-invocation"] as const;
export type MessagePartType = (typeof messagePartTypes)[number];

export const toolInvocationStates = [
  "partial-call",
  "call",
  "partial-result",
  "result",
] as const;
export type ToolInvocationState = (typeof toolInvocationStates)[number];

// === Users table ===

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

// === Chats table ===

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("chats_user_id_idx").on(table.userId),
    index("chats_created_at_idx").on(table.userId, table.createdAt),
  ],
);

// === Messages table ===

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role", { enum: messageRoles }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // Composite index for fetching messages by chat in chronological order
    index("messages_chat_id_created_at_idx").on(table.chatId, table.createdAt),
  ],
);

// === Message Parts table ===
// A message can have multiple parts (text, images, etc.)

export const messageParts = sqliteTable(
  "message_parts",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    type: text("type", { enum: messagePartTypes }).notNull(),
    order: text("order").notNull(), // Store as text to support large numbers
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // Composite index for fetching parts by message in order
    index("message_parts_message_id_order_idx").on(
      table.messageId,
      table.order,
    ),
  ],
);

// === Text Message Parts table ===

export const textMessageParts = sqliteTable(
  "text_message_parts",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .unique()
      .references(() => messageParts.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
  },
  (table) => [
    // Index for looking up by partId (commonly used in joins)
    index("text_message_parts_part_id_idx").on(table.partId),
  ],
);

// === Files table ===
// Stores uploaded files (for future image support)

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    r2Key: text("r2_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    size: text("size").notNull(), // Store as text for large numbers
    uploadedAt: text("uploaded_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // Unique index on r2_key for lookups by storage key
    index("files_r2_key_idx").on(table.r2Key),
  ],
);

// === Image Message Parts table ===

export const imageMessageParts = sqliteTable(
  "image_message_parts",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .unique()
      .references(() => messageParts.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    mimeType: text("mime_type").notNull(),
  },
  (table) => [
    // Index for looking up by partId (commonly used in joins)
    index("image_message_parts_part_id_idx").on(table.partId),
    // Index for finding image parts by file
    index("image_message_parts_file_id_idx").on(table.fileId),
  ],
);

// === Tool Invocation Message Parts table ===
// Stores tool calls and their results for persistence

export const toolInvocationMessageParts = sqliteTable(
  "tool_invocation_message_parts",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .unique()
      .references(() => messageParts.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    state: text("state", { enum: toolInvocationStates }).notNull(),
    input: text("input").notNull(), // JSON string of tool input args
    output: text("output"), // JSON string of tool output (nullable until result available)
  },
  (table) => [
    // Index for looking up by partId (commonly used in joins)
    index("tool_invocation_message_parts_part_id_idx").on(table.partId),
    // Index for finding tool invocations by toolCallId
    index("tool_invocation_message_parts_tool_call_id_idx").on(
      table.toolCallId,
    ),
  ],
);

// === Recipes table ===

export const recipes = sqliteTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(), // Current markdown content
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("recipes_user_id_idx").on(table.userId)],
);

// === Recipe Snapshots table ===
// Full markdown snapshots for version history

export const recipeSnapshots = sqliteTable(
  "recipe_snapshots",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    // Nullable: set if this version came from AI-assisted edit in a chat
    // null means user manually edited in markdown editor
    // Set to null on chat delete to preserve history
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(), // Full markdown snapshot
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("recipe_snapshots_recipe_id_idx").on(table.recipeId),
    index("recipe_snapshots_chat_id_idx").on(table.chatId),
  ],
);

// === Chat Active Recipes table ===
// Junction table: which recipes are active in which chat for cooking mode

export const chatActiveRecipes = sqliteTable(
  "chat_active_recipes",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    activatedAt: text("activated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("chat_active_recipes_chat_id_idx").on(table.chatId),
    index("chat_active_recipes_recipe_id_idx").on(table.recipeId),
    // Ensure a recipe can only be active once per chat
    uniqueIndex("chat_active_recipes_unique_idx").on(
      table.chatId,
      table.recipeId,
    ),
  ],
);

// === Relations ===

export const usersRelations = relations(users, ({ many }) => ({
  chats: many(chats),
  recipes: many(recipes),
}));

export const chatsRelations = relations(chats, ({ one, many }) => ({
  user: one(users, {
    fields: [chats.userId],
    references: [users.id],
  }),
  messages: many(messages),
  activeRecipes: many(chatActiveRecipes),
  recipeSnapshots: many(recipeSnapshots),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
  parts: many(messageParts),
}));

export const messagePartsRelations = relations(messageParts, ({ one }) => ({
  message: one(messages, {
    fields: [messageParts.messageId],
    references: [messages.id],
  }),
  textPart: one(textMessageParts, {
    fields: [messageParts.id],
    references: [textMessageParts.partId],
  }),
  imagePart: one(imageMessageParts, {
    fields: [messageParts.id],
    references: [imageMessageParts.partId],
  }),
  toolInvocationPart: one(toolInvocationMessageParts, {
    fields: [messageParts.id],
    references: [toolInvocationMessageParts.partId],
  }),
}));

export const textMessagePartsRelations = relations(
  textMessageParts,
  ({ one }) => ({
    part: one(messageParts, {
      fields: [textMessageParts.partId],
      references: [messageParts.id],
    }),
  }),
);

export const filesRelations = relations(files, ({ many }) => ({
  imageParts: many(imageMessageParts),
}));

export const imageMessagePartsRelations = relations(
  imageMessageParts,
  ({ one }) => ({
    part: one(messageParts, {
      fields: [imageMessageParts.partId],
      references: [messageParts.id],
    }),
    file: one(files, {
      fields: [imageMessageParts.fileId],
      references: [files.id],
    }),
  }),
);

export const toolInvocationMessagePartsRelations = relations(
  toolInvocationMessageParts,
  ({ one }) => ({
    part: one(messageParts, {
      fields: [toolInvocationMessageParts.partId],
      references: [messageParts.id],
    }),
  }),
);

export const recipesRelations = relations(recipes, ({ one, many }) => ({
  user: one(users, {
    fields: [recipes.userId],
    references: [users.id],
  }),
  snapshots: many(recipeSnapshots),
  activeInChats: many(chatActiveRecipes),
}));

export const recipeSnapshotsRelations = relations(
  recipeSnapshots,
  ({ one }) => ({
    recipe: one(recipes, {
      fields: [recipeSnapshots.recipeId],
      references: [recipes.id],
    }),
    chat: one(chats, {
      fields: [recipeSnapshots.chatId],
      references: [chats.id],
    }),
  }),
);

export const chatActiveRecipesRelations = relations(
  chatActiveRecipes,
  ({ one }) => ({
    chat: one(chats, {
      fields: [chatActiveRecipes.chatId],
      references: [chats.id],
    }),
    recipe: one(recipes, {
      fields: [chatActiveRecipes.recipeId],
      references: [recipes.id],
    }),
  }),
);

// === Type Exports ===

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type MessagePart = typeof messageParts.$inferSelect;
export type NewMessagePart = typeof messageParts.$inferInsert;

export type TextMessagePart = typeof textMessageParts.$inferSelect;
export type NewTextMessagePart = typeof textMessageParts.$inferInsert;

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;

export type ImageMessagePart = typeof imageMessageParts.$inferSelect;
export type NewImageMessagePart = typeof imageMessageParts.$inferInsert;

export type ToolInvocationMessagePart =
  typeof toolInvocationMessageParts.$inferSelect;
export type NewToolInvocationMessagePart =
  typeof toolInvocationMessageParts.$inferInsert;

export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;

export type RecipeSnapshot = typeof recipeSnapshots.$inferSelect;
export type NewRecipeSnapshot = typeof recipeSnapshots.$inferInsert;

export type ChatActiveRecipe = typeof chatActiveRecipes.$inferSelect;
export type NewChatActiveRecipe = typeof chatActiveRecipes.$inferInsert;

// === Composite Types ===

export type ChatWithMessages = Chat & {
  messages: Message[];
};

export type ChatWithActiveRecipes = Chat & {
  activeRecipes: (ChatActiveRecipe & {
    recipe: Recipe;
  })[];
};

export type RecipeWithSnapshots = Recipe & {
  snapshots: RecipeSnapshot[];
};

export type FullChat = Chat & {
  messages: Message[];
  activeRecipes: (ChatActiveRecipe & {
    recipe: Recipe;
  })[];
};
