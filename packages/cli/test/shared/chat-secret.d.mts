/** Types for chat-secret.mjs, which the tests under src/ import (tsc reads no .mjs). */
export declare const CHAT_SECRET: RegExp;
/** The sentence that asks for a secret through the chat, or null. */
export declare function asksForSecretInChat(text: string | null | undefined): string | null;
