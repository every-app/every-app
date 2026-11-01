/**
 * agentic-inbox as it ports to Every App (the ports plan, §3): the
 * manifest of `everyapp.config.ts` once L1 has filled `ai.models` and L6
 * has replaced `EmailMCP` (and `mcp: "app"`) with a `defineTools()`
 * catalog, and its `cloudflare.config.ts` as `cf build` evaluates it in
 * production. One Worker with two SQLite Durable Objects and the bucket
 * named after itself, bound by hand; no secrets, no triggers, no `ai` or
 * `send_email` binding (the gateway brokers both). `capabilities.email`
 * and `email: { inbound: true }` come with PR 3; its addresses are set
 * with `everyapp email set`.
 */
import { bindings } from "@cloudflare/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { FakeAppConfig } from "@/test/fakeCloudflare";

export const agenticInbox = {
  id: "agentic-inbox",
  name: "Agentic Inbox",
  description: "An email client with an AI agent, for the organization's own domains.",
  resources: {
    durableObjects: [
      { name: "MAILBOX", className: "MailboxDO" },
      { name: "EMAIL_AGENT", className: "EmailAgent" },
    ],
  },
  providers: ["workers-ai", "openrouter"],
  ai: {
    models: [
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/meta/llama-3.1-8b-instruct-fast",
      "@cf/moonshotai/kimi-k2.6",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-3.1-8b-instruct",
      "moonshotai/kimi-k2",
    ],
  },
  access: "everyone",
  public: [],
} as const satisfies EveryAppCliManifest;

/** The production build of the inbox's Worker, from its manifest. */
export const agenticInboxConfig: FakeAppConfig = ({ manifest, root }) => {
  const worker = everyAppWorker({
    manifest,
    entrypoint: "./workers/app.ts",
    ctx: { mode: "production" },
    root,
  });
  return {
    worker: {
      ...worker,
      env: {
        ...worker.env,
        BUCKET: bindings.r2({ name: worker.name }),
        DOMAINS: bindings.text("example.com"),
        EMAIL_ADDRESSES: bindings.json([] as string[]),
        AI_PROVIDER: bindings.text("workers-ai"),
        AGENT_MODEL: bindings.text(""),
      },
    },
  };
};
