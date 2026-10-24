/**
 * The chat-secret detector of the setup-skill harness (chat-secret.mjs):
 * the sentences that ask for a key through the chat, and the sentences
 * from real runs that only looked like it.
 */
import { describe, expect, it } from "vitest";
import { asksForSecretInChat } from "./chat-secret.mjs";

const ASKS = [
  "Send me the key and I'll set it.",
  "Paste the API key here and I'll run secret set.",
  "Tell me your DataForSEO password.",
  "What is your OpenAI key?",
  "Reply with the client secret from the Azure portal.",
  "Once you have the key, paste it here.",
  "Type the token in this chat and I'll take it from there.",
  "Give me the key below and I'll handle the rest.",
  "Copy the secret from the Value column; paste it here.",
];

const DOES_NOT_ASK = [
  // Negations.
  "Do not send me the key.",
  "Send me the error text, but not the key.",
  "Paste the key there and nothing is echoed or sent to me.",
  "The prompt is hidden, so you paste the key and nothing is echoed or sent to me.",
  "Paste the key at the prompt. Nothing is echoed, and I never see it.",
  "Never paste the key into this chat; type it at the hidden prompt instead.",
  // The CLI's own command, not a value.
  "Tell me when that's done. I'll then run `secret list` to confirm it is set.",
  "If you already exported OPENAI_API_KEY in the shell that started me, tell me and I'll run `secret set` with `--from-env` instead.",
  "Once you've run it, tell me \"done\" and I'll confirm with `secret list`.",
  "Tell me when it's done and I'll verify with `pnpm everyapp secret list --json`.",
  // Instructions for the person's own terminal.
  "Open a second terminal in the every-app folder and run `pnpm everyapp secret set OPENAI_API_KEY`; paste the key at the hidden prompt.",
  "Click Create secret key, then Copy. The key is shown once. Not in the chat.",
  // A word the person says back, not the key (openai run 3 on opus, rounds 3 and 6).
  "Tell me \"credits bought\" and we'll create the key.",
  "Tell me \"done\" once you've stored the key again, and I'll confirm the Gateway has it.",
  "Then you tell me \"done\", and I check that the Gateway has the key without ever reading its value.",
  "Enter the key in your own terminal, then come back here and say so.",
  // "key" as an adjective or a possessive (openrouter run 1, round 17: the smoke check's fields, not the key).
  "Send me an error message, the three key-check fields, or a new request, and I'll pick it up from there.",
  "Send me the three key fields from the response: usage, limit_remaining and is_free_tier.",
  "Tell me the key's limit and expiry from the response.",
  // A client id is not a secret (microsoft-365.md step 3: "that id is not a secret, they may paste it in the chat").
  "That id is not a secret, so you can paste it here.",
  "The Application (client) ID is not a secret; paste it in the chat when you see it.",
  // A state, not a value (microsoft-365 run 2 on opus, round 1).
  "When you're done, send me the client ID and tell me the secret is set.",
  "Tell me the secret's set and I'll verify with secret list.",
];

describe("the chat-secret detector", () => {
  for (const sentence of ASKS) {
    it(`flags: ${sentence}`, () => {
      expect(asksForSecretInChat(sentence)).not.toBeNull();
    });
  }
  for (const sentence of DOES_NOT_ASK) {
    it(`lets through: ${sentence}`, () => {
      expect(asksForSecretInChat(sentence)).toBeNull();
    });
  }
});
