/**
 * Inference: five AI providers (`ai` entries) and five per-call model APIs.
 *
 * Catalog entries written from each provider's own documentation on
 * 2026-10-25 by one research agent per batch and checked by a second
 * (docs/design/2026-10-provider-registry.md, section 9); an entry the
 * checker could not confirm says `verified: false` and why. Each is the
 * JSON `everyapp provider add` takes, as a literal, so the ids and setting
 * names stay types (`CapabilityId`, `CapabilitySecret`).
 */
import type {
  AiProviderCapability,
  ApiKeyCapability,
} from "../capabilities.js";

export const INFERENCE = {
  // Bearer is the documented header today; x-api-key is the legacy fallback. A workspace-scoped key keeps anthropic-workspace-id harmless.
  anthropic: {
    mode: "ai",
    label: "Anthropic",
    description: "Claude models through the Messages API.",
    auth: {
      kind: "bearer",
      secret: "ANTHROPIC_API_KEY",
    },
    docs: "https://platform.claude.com/settings/keys",
    api: "https://platform.claude.com/docs/en/api/overview",
    origin: "https://api.anthropic.com",
    inferenceRoutes: ["/v1/messages", "/v1/messages/count_tokens"],
    hint: "An API key from the Claude Console's API keys page; the Gateway sends it as a bearer token. Apps send the anthropic-version header themselves.",
    secrets: [
      {
        name: "ANTHROPIC_API_KEY",
        hint: "A key scoped to one workspace, so no call needs an anthropic-workspace-id header.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/models",
      expect: [200],
      free: true,
      note: "Send an anthropic-version header, as every call does.",
    },
    rate: {
      note: "Requests and tokens per minute by usage tier, on the Console's Rate limits page; token counting is free, with its own per-minute limit.",
    },
    example: "summarize this support thread in three bullet points",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm"],
  },
  gemini: {
    mode: "ai",
    label: "Google Gemini",
    description:
      "Google's Gemini models through their OpenAI-compatible endpoint: chat, embeddings, images.",
    auth: {
      kind: "bearer",
      secret: "GEMINI_API_KEY",
    },
    docs: "https://aistudio.google.com/apikey",
    api: "https://ai.google.dev/gemini-api/docs/openai",
    origin: "https://generativelanguage.googleapis.com",
    inferenceRoutes: [
      "/v1beta/openai/chat/completions",
      "/v1beta/openai/embeddings",
      "/v1beta/openai/images/generations",
    ],
    hint: "An API key from Google AI Studio; the Gateway sends it as a bearer token. Apps call Gemini's OpenAI-shaped paths under /v1beta/openai.",
    secrets: [
      {
        name: "GEMINI_API_KEY",
        hint: "A Google AI Studio key restricted to the Gemini API only.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1beta/openai/models",
      expect: [200],
      free: true,
    },
    rate: {
      note: "Per project, not per key: requests and tokens per minute and requests per day, by tier (Free, then Tiers 1 to 3).",
    },
    example: "describe what is in this product photo",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm", "embeddings", "images"],
  },
  mistral: {
    mode: "ai",
    label: "Mistral AI",
    description:
      "Mistral's models: chat, code completion, embeddings, moderation, OCR, speech.",
    auth: {
      kind: "bearer",
      secret: "MISTRAL_API_KEY",
    },
    docs: "https://console.mistral.ai",
    api: "https://docs.mistral.ai/api/",
    origin: "https://api.mistral.ai",
    inferenceRoutes: [
      "/v1/chat/completions",
      "/v1/fim/completions",
      "/v1/embeddings",
      "/v1/moderations",
      "/v1/chat/moderations",
      "/v1/classifications",
      "/v1/chat/classifications",
      "/v1/ocr",
      "/v1/audio/transcriptions",
      "/v1/audio/speech",
    ],
    hint: "An API key from API Keys in the Mistral Studio console; the Gateway sends it as a bearer token. Free mode needs no card; usage and rate limits apply.",
    secrets: [
      {
        name: "MISTRAL_API_KEY",
        hint: "A key from API Keys in the Studio console, with an expiry date.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/models",
      expect: [200],
      free: true,
    },
    example: "extract the text from this scanned invoice",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm", "ocr", "embeddings"],
  },
  groq: {
    mode: "ai",
    label: "Groq",
    description:
      "Open models on Groq through OpenAI's API shape: chat, responses, transcription, speech.",
    auth: {
      kind: "bearer",
      secret: "GROQ_API_KEY",
    },
    docs: "https://console.groq.com/keys",
    api: "https://console.groq.com/docs/api-reference",
    origin: "https://api.groq.com",
    inferenceRoutes: [
      "/openai/v1/chat/completions",
      "/openai/v1/responses",
      "/openai/v1/audio/transcriptions",
      "/openai/v1/audio/translations",
      "/openai/v1/audio/speech",
    ],
    hint: "An API key from the Groq console; the Gateway sends it as a bearer token. Apps call the OpenAI-shaped paths under /openai/v1.",
    secrets: [
      {
        name: "GROQ_API_KEY",
        hint: "A key from the API Keys page of the Groq console.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/openai/v1/models",
      expect: [200],
      free: true,
    },
    rate: {
      note: "Requests and tokens per minute and per day, per model and plan, for the whole organization; the console Limits page shows them.",
    },
    example: "transcribe this voice memo",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm", "speech"],
  },
  cohere: {
    mode: "ai",
    label: "Cohere",
    description:
      "Cohere's models: chat, embeddings, reranking, classification, transcription, document parsing.",
    auth: {
      kind: "bearer",
      secret: "COHERE_API_KEY",
    },
    docs: "https://dashboard.cohere.com/api-keys",
    api: "https://docs.cohere.com/reference/about",
    origin: "https://api.cohere.com",
    inferenceRoutes: [
      "/v2/chat",
      "/v2/embed",
      "/v2/rerank",
      "/v1/classify",
      "/v2/audio/transcriptions",
      "/v2/parse",
      "/v1/tokenize",
      "/v1/detokenize",
    ],
    hint: "An API key from the Cohere dashboard; the Gateway sends it as a bearer token. Trial keys are free and limited; production keys are paid.",
    secrets: [
      {
        name: "COHERE_API_KEY",
        hint: "A production key; a trial key is limited to 1,000 calls a month.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/models",
      expect: [200],
      free: true,
    },
    rate: {
      note: "Production: 500 calls a minute for Command A chat and most endpoints, rerank 1,000. Trial: 20 chat calls a minute, 1,000 calls a month.",
    },
    example: "rerank these search results for the query refund policy",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm", "embeddings", "rerank"],
  },
  voyage: {
    mode: "api_key",
    label: "Voyage AI",
    description:
      "Embeddings and rerankers for search and retrieval: text, code, multimodal, contextualized chunks.",
    auth: {
      kind: "bearer",
      secret: "VOYAGE_API_KEY",
    },
    docs: "https://dashboard.voyageai.com/organization/api-keys",
    api: "https://docs.voyageai.com/reference/embeddings-api",
    hosts: ["api.voyageai.com"],
    data: "per-call",
    access: ["read"],
    readMethods: ["POST"],
    accountWidePaths: [
      ["v1", "files"],
      ["v1", "batches"],
    ],
    hint: "A secret key from the Voyage dashboard; the Gateway sends it as a bearer token. Apps POST to /v1/embeddings, /v1/multimodalembeddings, /v1/contextualizedembeddings and /v1/rerank.",
    secrets: [
      {
        name: "VOYAGE_API_KEY",
        hint: "A secret key from API keys in the Voyage dashboard.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/batches",
      expect: [200],
      free: true,
      note: "Lists the organization's batches, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    cost: {
      unit: "token",
      note: "voyage-4 $0.06 per million tokens; the first 200 million tokens of the voyage-4 family are free per account.",
    },
    rate: {
      perMinute: 2000,
      note: "2,000 requests a minute at tier 1, doubled at tier 2, tripled at tier 3; tokens per minute vary by model.",
    },
    example: "embed these product descriptions for semantic search",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["embeddings", "rerank", "search"],
  },
  perplexity: {
    mode: "api_key",
    label: "Perplexity",
    description:
      "Web-grounded answers from the Agent API, raw web search results, and embeddings.",
    auth: {
      kind: "bearer",
      secret: "PERPLEXITY_API_KEY",
    },
    docs: "https://console.perplexity.ai/project/keys",
    api: "https://docs.perplexity.ai/api-reference/agent-post",
    hosts: ["api.perplexity.ai"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [
      ["v1", "batches"],
      ["v1", "files"],
      ["v1", "skills"],
      ["v1", "analytics"],
      ["v2", "analytics"],
      ["generate_auth_token"],
      ["revoke_auth_token"],
    ],
    hint: "An API key from the Perplexity console; the Gateway sends it as a bearer token. Apps POST to /v1/agent for researched answers and /search for result lists, and GET /v1/agent/{id} to poll a background run.",
    secrets: [
      {
        name: "PERPLEXITY_API_KEY",
        hint: "An API key from the project's API keys page in the Perplexity console.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/orchestrator/v1/models",
      expect: [200],
      free: true,
    },
    cost: {
      unit: "token",
      note: "Agent API per token plus tool fees (web_search $0.0025 a call); Search API $5 per 1,000 requests.",
    },
    example:
      "research the latest pricing changes from our three main competitors",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["search", "ai", "research"],
  },
  // r.jina.ai's /echo reflects the request, key included: refused as an account-wide path.
  jina: {
    mode: "api_key",
    label: "Jina AI",
    description:
      "Reads web pages as Markdown, searches the web, and embeds and reranks text and images.",
    auth: {
      kind: "bearer",
      secret: "JINA_API_KEY",
    },
    docs: "https://jina.ai/api-dashboard/key-manager",
    api: "https://docs.jina.ai/",
    hosts: ["api.jina.ai", "r.jina.ai", "s.jina.ai"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [["v1", "batches"], ["echo"]],
    hint: 'An API key from the Jina API dashboard; the Gateway sends it as a bearer token. Reader is r.jina.ai (POST {"url": ...}), Search is s.jina.ai, and embeddings and rerank are on api.jina.ai.',
    secrets: [
      {
        name: "JINA_API_KEY",
        hint: "A key starting jina_, from Manage API Key in the Jina API dashboard.",
      },
    ],
    smoke: {
      method: "GET",
      host: "api.jina.ai",
      path: "/v1/batches",
      expect: [200],
      free: true,
      note: "Lists the account's batch jobs, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    cost: {
      unit: "token",
      note: "Billed in tokens against the account balance; GET /v1/models lists each model's price.",
    },
    rate: {
      note: "Reader 500 requests a minute, Search 100, embeddings and rerank 500; premium keys get ten times more.",
    },
    example: "read this article as Markdown and pull out the key claims",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["scrape", "search", "embeddings", "rerank"],
  },
  replicate: {
    mode: "api_key",
    label: "Replicate",
    description:
      "Runs open-source and official models by API: images, video, audio and language.",
    auth: {
      kind: "bearer",
      secret: "REPLICATE_API_TOKEN",
    },
    docs: "https://replicate.com/account/api-tokens",
    api: "https://replicate.com/docs/reference/http",
    hosts: ["api.replicate.com"],
    data: "per-call",
    access: ["read"],
    readMethods: ["POST"],
    accountWidePaths: [
      ["v1", "account"],
      ["v1", "deployments"],
      ["v1", "files"],
      ["v1", "webhooks"],
      ["trainings"],
    ],
    hint: "An API token from Replicate's API tokens page; the Gateway sends it as a bearer token. Apps POST to /v1/models/{owner}/{name}/predictions or /v1/predictions with Prefer: wait (up to 60 seconds), or pass a webhook URL for longer runs.",
    secrets: [
      {
        name: "REPLICATE_API_TOKEN",
        hint: "An API token from the API tokens page of the Replicate account.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/account",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    rate: {
      perMinute: 600,
      note: "Creating predictions 600 a minute; every other endpoint 3,000 a minute.",
    },
    example: "generate a product photo of a ceramic mug on a wooden table",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "images", "video", "audio"],
  },
  // The router forwards X-HF-Bill-To as sent, so an app can bill any organization the token's user belongs to (TODO.md).
  huggingface: {
    mode: "api_key",
    label: "Hugging Face Inference",
    description:
      "Open models from Hugging Face's inference providers through one router: chat, embeddings, images, speech.",
    auth: {
      kind: "bearer",
      secret: "HUGGINGFACE_API_TOKEN",
    },
    docs: "https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained",
    api: "https://huggingface.co/docs/inference-providers/index",
    hosts: ["router.huggingface.co"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [],
    hint: "A fine-grained access token from Hugging Face settings with the Inference Providers permission; the Gateway sends it as a bearer token. Apps POST OpenAI-style chat to /v1/chat/completions, or other tasks under /<provider>/, such as /hf-inference/models/<model>.",
    secrets: [
      {
        name: "HUGGINGFACE_API_TOKEN",
        hint: "A fine-grained token with only the Make calls to Inference Providers permission.",
      },
    ],
    cost: {
      unit: "call",
      note: "Pay as you go at each provider's own rate with no markup; PRO accounts get $2 of compute credits a month.",
    },
    example: "embed these support articles for semantic search",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ai", "llm", "embeddings", "images"],
  },
} as const satisfies Record<string, ApiKeyCapability | AiProviderCapability>;
