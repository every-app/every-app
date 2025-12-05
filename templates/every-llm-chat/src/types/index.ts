import type { InferSelectModel } from "drizzle-orm";
import { chats } from "@/db/schema";

export type Chat = InferSelectModel<typeof chats>;
