import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";

// Users table
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const usersRelations = relations(users, ({ many }) => ({
  chats: many(chats),
  files: many(files),
}));

// Chats table
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
  (table) => [index("chats_user_id_idx").on(table.userId)],
);

export const chatsRelations = relations(chats, ({ many, one }) => ({
  messages: many(messages),
  user: one(users, {
    fields: [chats.userId],
    references: [users.id],
  }),
}));

// Messages table
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("messages_chat_id_idx").on(table.chatId)],
);

export const messagesRelations = relations(messages, ({ many, one }) => ({
  parts: many(messageParts),
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

// Message parts table - a message can have multiple parts
export const messageParts = sqliteTable(
  "message_parts",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["text", "image"] }).notNull(),
    order: integer("order").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("message_parts_message_id_idx").on(table.messageId),
    unique("message_parts_message_id_order_uniq").on(
      table.messageId,
      table.order,
    ),
  ],
);

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
}));

// Files table - stores uploaded files
export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    uploadedAt: text("uploaded_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("files_user_id_idx").on(table.userId),
    uniqueIndex("files_r2_key_idx").on(table.r2Key),
  ],
);

export const filesRelations = relations(files, ({ one, many }) => ({
  user: one(users, {
    fields: [files.userId],
    references: [users.id],
  }),
  imageParts: many(imageMessageParts),
}));

// Text message parts table
export const textMessageParts = sqliteTable(
  "text_message_parts",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => messageParts.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
  },
  (table) => [uniqueIndex("text_message_parts_part_id_idx").on(table.partId)],
);

export const textMessagePartsRelations = relations(
  textMessageParts,
  ({ one }) => ({
    part: one(messageParts, {
      fields: [textMessageParts.partId],
      references: [messageParts.id],
    }),
  }),
);

// Image message parts table
export const imageMessageParts = sqliteTable(
  "image_message_parts",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => messageParts.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("image_message_parts_part_id_idx").on(table.partId)],
);

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
