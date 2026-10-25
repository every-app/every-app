/**
 * Search, scraping, speech and news: per-call APIs whose reads are POSTs.
 *
 * Catalog entries written from each provider's own documentation on
 * 2026-10-25 by one research agent per batch and checked by a second
 * (docs/design/2026-10-provider-registry.md, section 9); an entry the
 * checker could not confirm says `verified: false` and why. Each is the
 * JSON `everyapp provider add` takes, as a literal, so the ids and setting
 * names stay types (`CapabilityId`, `CapabilitySecret`).
 */
import type { ApiKeyCapability } from "../capabilities.js";

export const SEARCH = {
  firecrawl: {
    mode: "api_key",
    label: "Firecrawl",
    description:
      "Scrapes, crawls, maps and searches the web, returning clean markdown or structured data.",
    auth: {
      kind: "bearer",
      secret: "FIRECRAWL_API_KEY",
    },
    docs: "https://www.firecrawl.dev/app/api-keys",
    api: "https://docs.firecrawl.dev/api-reference/introduction",
    hosts: ["api.firecrawl.dev"],
    data: "per-call",
    access: ["read", "write"],
    readMethods: ["GET", "POST"],
    writeMethods: ["DELETE"],
    accountWidePaths: [
      ["team"],
      ["crawl", "active"],
      ["monitor"],
      ["agent"],
      ["interact"],
      ["support", "ask"],
    ],
    hint: "An API key from Firecrawl's API keys page; the Gateway sends it as a bearer token. Scrape, crawl, map, search and extract are POSTs and job status is a GET; cancelling a crawl or batch (DELETE) needs write.",
    secrets: [
      {
        name: "FIRECRAWL_API_KEY",
        hint: "An API key from Firecrawl's API keys page; it starts with fc-.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v2/team/credit-usage",
      expect: [200],
      free: true,
      note: "Remaining credits; account-wide, so the Gateway refuses it for apps: run it from the person's terminal.",
    },
    cost: {
      unit: "result",
      note: "Credits: 1 per page scraped or crawled, 1 per map call, 2 per 10 search results; JSON extraction and other options add more.",
    },
    rate: {
      note: "Per team per minute, by plan: /scrape 10 on Free, 100 Hobby, 500 Standard, 5,000 Growth; /crawl 2, 20, 100, 1,000.",
    },
    example: "scrape https://example.com/pricing into markdown",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["scrape", "crawl", "search"],
  },
  exa: {
    mode: "api_key",
    label: "Exa",
    description:
      "Web search built for AI: search results, page contents, similar links and cited answers.",
    auth: {
      kind: "header",
      secret: "EXA_API_KEY",
      header: "x-api-key",
    },
    docs: "https://dashboard.exa.ai/api-keys",
    api: "https://exa.ai/docs/reference/search",
    hosts: ["api.exa.ai"],
    data: "per-call",
    access: ["read"],
    readMethods: ["POST"],
    accountWidePaths: [["websets"], ["monitors"], ["agent"], ["batches"]],
    hint: "An API key from the Exa dashboard (the free tier gives $10 of credit a month); the Gateway sends it in the x-api-key header. Search, contents, find-similar and answer are POSTs.",
    secrets: [
      {
        name: "EXA_API_KEY",
        hint: "An API key from the API keys page of the Exa dashboard.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/websets/v0/teams/me",
      expect: [200],
      free: true,
      note: "Team info under the Websets API (the docs page leaves out the /websets prefix); account-wide, so run it from the person's terminal.",
    },
    cost: {
      unit: "call",
      usd: 0.007,
      note: "Search $7 per 1k (auto and fast; lite $4), contents $1 per 1k pages, answer $5 per 1k; up to 10 results included.",
    },
    rate: {
      perSecond: 10,
      note: "Per team: /search and /answer 10 QPS, deep search 5, /contents 100.",
    },
    example: "find recent articles about solid-state batteries",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["search"],
  },
  tavily: {
    mode: "api_key",
    label: "Tavily",
    description:
      "Web search, page extraction, crawling and site maps for AI agents, plus research reports.",
    auth: {
      kind: "bearer",
      secret: "TAVILY_API_KEY",
    },
    docs: "https://app.tavily.com",
    api: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    hosts: ["api.tavily.com"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [["usage"], ["logs"], ["org-usage"]],
    hint: "An API key from app.tavily.com (1,000 free credits a month); the Gateway sends it as a bearer token. Search, extract, crawl, map and research are POSTs; a research result is a GET.",
    secrets: [
      {
        name: "TAVILY_API_KEY",
        hint: "An API key from the Tavily dashboard; it starts with tvly-.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/usage",
      expect: [200],
      free: true,
      note: "Key and account usage, not an endpoint that costs credits; account-wide, so run it from the person's terminal (10 calls per 10 minutes).",
    },
    cost: {
      unit: "call",
      usd: 0.008,
      note: "Pay as you go $0.008 per credit: basic search 1 credit, advanced 2; extract 1 credit per 5 URLs; map 1 per 10 pages.",
    },
    rate: {
      perMinute: 100,
      note: "Development keys 100 per minute, production keys 1,000; crawl 100 and research 20 per minute for both.",
    },
    example: "search the web for this week's news on EU AI rules",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["search", "scrape"],
  },
  // Unverified: Serper publishes no API reference; the request shape is read from its playground.
  serper: {
    mode: "api_key",
    label: "Serper",
    description:
      "Google search results as JSON: web, news, images, places, shopping, scholar and patents.",
    auth: {
      kind: "header",
      secret: "SERPER_API_KEY",
      header: "X-API-KEY",
    },
    docs: "https://serper.dev/api-keys",
    api: "https://serper.dev/playground",
    hosts: ["google.serper.dev", "scrape.serper.dev"],
    data: "per-call",
    access: ["read"],
    readMethods: ["POST"],
    accountWidePaths: [],
    hint: 'An API key from serper.dev (2,500 free queries to start); the Gateway sends it in the X-API-KEY header. Every search is a POST to google.serper.dev/<type> (search, news, images, places, …) with a JSON body such as {"q": "…"}.',
    secrets: [
      {
        name: "SERPER_API_KEY",
        hint: "The API key on serper.dev's API keys page.",
      },
    ],
    cost: {
      unit: "call",
      usd: 0.001,
      note: "Prepaid credits, one per successful query: $1.00 per 1k on the 50k pack, down to $0.30 per 1k on the largest.",
    },
    rate: {
      perSecond: 50,
      note: "Starter credits 50 queries per second; Standard 100, Scale 200, Ultimate 300.",
    },
    example: "get the top Google results for best project management software",
    verified: false,
    tags: ["search", "serp"],
  },
  "brave-search": {
    mode: "api_key",
    label: "Brave Search",
    description:
      "Brave's independent web index: web, news, images, videos, places, LLM context and answers.",
    auth: {
      kind: "header",
      secret: "BRAVE_SEARCH_API_KEY",
      header: "X-Subscription-Token",
    },
    docs: "https://api-dashboard.search.brave.com/app/keys",
    api: "https://api-dashboard.search.brave.com/documentation",
    hosts: ["api.search.brave.com"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [],
    hint: "Activate a plan (it includes $5 of free credit a month), then create a key under API Keys; the Gateway sends it in the X-Subscription-Token header. Searches are GETs (POST works too); answers are a POST to /res/v1/chat/completions.",
    secrets: [
      {
        name: "BRAVE_SEARCH_API_KEY",
        hint: "A key from the API Keys section of the Brave Search API dashboard, made after activating a plan.",
      },
    ],
    cost: {
      unit: "call",
      usd: 0.005,
      note: "Search $5 per 1k requests; Answers $4 per 1k plus $5 per million tokens; $5 free credit a month; only successful calls count.",
    },
    rate: {
      perSecond: 50,
      note: "Search plan 50 queries per second; Answers 2 per second.",
    },
    example: "search the web for the latest Cloudflare Workers release notes",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["search"],
  },
  apify: {
    mode: "api_key",
    label: "Apify",
    description:
      "Runs Apify Actors (ready-made scrapers and automations) and reads their datasets and stores.",
    auth: {
      kind: "bearer",
      secret: "APIFY_API_TOKEN",
    },
    docs: "https://console.apify.com/settings/integrations",
    api: "https://docs.apify.com/api/v2",
    hosts: ["api.apify.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PUT", "DELETE"],
    accountWidePaths: [
      ["users"],
      ["webhooks"],
      ["webhook-dispatches"],
      ["env-vars"],
    ],
    hint: "The API token from Apify Console, Settings > API & Integrations; the Gateway sends it as a bearer token. Reading Actors, runs and datasets needs read; starting a run is a POST, so it needs write.",
    secrets: [
      {
        name: "APIFY_API_TOKEN",
        hint: "The API token under Settings > API & Integrations in Apify Console.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v2/users/me",
      expect: [200],
      free: true,
      note: "The docs' verify call; account-wide, so the Gateway refuses it for apps: run it from the person's terminal.",
    },
    rate: {
      perSecond: 60,
      note: "60 requests per second per resource (one Actor, run, dataset or store); 250,000 requests per minute per user overall.",
    },
    example:
      "run the Google Maps scraper Actor for coffee shops in Austin and list the results",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["scrape", "automation"],
  },
  deepgram: {
    mode: "api_key",
    label: "Deepgram",
    description: "Speech to text, text to speech and text analysis.",
    auth: {
      kind: "bearer",
      secret: "DEEPGRAM_API_KEY",
      scheme: "Token",
    },
    docs: "https://console.deepgram.com/",
    api: "https://developers.deepgram.com/reference/deepgram-api-overview",
    hosts: [
      "api.deepgram.com",
      "api.eu.deepgram.com",
      "api.au.deepgram.com",
      "api.in.deepgram.com",
    ],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [["projects"], ["auth", "grant"]],
    hint: "An API key from the Deepgram Console; the Gateway sends it as Authorization: Token <key>, and the EU, Australia and India hosts take the same key. Transcription (/v1/listen), speech (/v1/speak) and text analysis (/v1/read) are POSTs.",
    secrets: [
      {
        name: "DEEPGRAM_API_KEY",
        hint: "A project API key created in the Deepgram Console.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/models",
      expect: [200],
      free: true,
      note: "Lists the public models; it needs the key and processes no audio.",
    },
    cost: {
      unit: "call",
      note: "Nova-3 pre-recorded $0.0043 per audio minute (pay as you go); Aura-2 speech $0.030 per 1k characters; $200 free credit.",
    },
    rate: {
      note: "Concurrency per project on pay as you go: 50 pre-recorded transcriptions, 15 text-to-speech requests.",
    },
    example: "transcribe this podcast episode and label the speakers",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["speech", "transcription"],
  },
  elevenlabs: {
    mode: "api_key",
    label: "ElevenLabs",
    description:
      "Text to speech, speech to text, sound effects, music and voice changing.",
    auth: {
      kind: "header",
      secret: "ELEVENLABS_API_KEY",
      header: "xi-api-key",
    },
    docs: "https://elevenlabs.io/app/settings/api-keys",
    api: "https://elevenlabs.io/docs/api-reference/introduction",
    hosts: ["api.elevenlabs.io"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET", "POST"],
    accountWidePaths: [
      ["v1", "user"],
      ["v1", "usage"],
      ["v1", "workspace"],
      ["v1", "workspaces"],
      ["v1", "service-accounts"],
      ["v1", "history"],
      ["v1", "single-use-token"],
      ["v1", "convai"],
      ["v1", "dubbing"],
      ["v1", "studio"],
      ["v1", "pronunciation-dictionaries"],
      ["v1", "voices", "add"],
      ["v1", "voices", "pvc"],
      ["v1", "voices", "collections"],
      ["edit"],
      ["replicate-to-isolated-environment"],
      ["v1", "text-to-voice"],
      ["v1", "audio-native"],
      ["v1", "productions"],
      ["v1", "speech-engine"],
      ["v1", "music", "finetunes"],
      ["v1", "flows"],
      ["v1", "assets"],
      ["v1", "audio-isolation", "history"],
    ],
    hint: "An API key from ElevenLabs' API keys page; the Gateway sends it in the xi-api-key header. Speech, transcription and sound generation are POSTs; listing voices and models are GETs.",
    secrets: [
      {
        name: "ELEVENLABS_API_KEY",
        hint: "An API key from ElevenLabs' API keys page; it can be scoped to the endpoints the app uses and given a credit cap.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/models",
      expect: [200],
      free: true,
      note: "The first request in ElevenLabs' authentication docs; it generates nothing.",
    },
    example: "read this paragraph aloud in a calm narrator voice",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["speech", "audio"],
  },
  // `account`, not per-call: GET /v2/transcript lists every transcript on the account and shares its segment with /v2/transcript/<id>.
  assemblyai: {
    mode: "api_key",
    label: "AssemblyAI",
    description:
      "Transcribes recorded audio and video, with speaker labels, redaction and subtitles.",
    auth: {
      kind: "header",
      secret: "ASSEMBLYAI_API_KEY",
      header: "Authorization",
    },
    docs: "https://www.assemblyai.com/dashboard/home",
    api: "https://www.assemblyai.com/docs",
    hosts: ["api.assemblyai.com", "api.eu.assemblyai.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "POST"],
    writeMethods: ["DELETE"],
    accountWidePaths: [],
    hint: "The API key from your AssemblyAI dashboard; the Gateway sends it as the whole Authorization header, with no Bearer word. Audio is submitted with a POST to /v2/transcript and the app polls GET /v2/transcript/<id>; deleting a transcript needs write.",
    secrets: [
      {
        name: "ASSEMBLYAI_API_KEY",
        hint: "The API key on your AssemblyAI dashboard.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v2/transcript?limit=1",
      expect: [200],
      free: true,
      note: "Lists the account's latest transcript; it transcribes nothing.",
    },
    cost: {
      unit: "call",
      note: "Per hour of audio submitted: Universal-3.5 Pro $0.21, Universal-2 $0.15; the free tier covers up to 185 hours of pre-recorded audio.",
    },
    rate: {
      perMinute: 4000,
      note: "20,000 requests per 5 minutes per account; 5 transcriptions in parallel on free accounts, 200 or more on paid.",
    },
    example: "transcribe this sales call recording with speaker labels",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["speech", "transcription"],
  },
  newsapi: {
    mode: "api_key",
    label: "NewsAPI",
    description:
      "Searches news articles and live headlines from over 150,000 sources.",
    auth: {
      kind: "header",
      secret: "NEWSAPI_API_KEY",
      header: "X-Api-Key",
    },
    docs: "https://newsapi.org/register",
    api: "https://newsapi.org/docs",
    hosts: ["newsapi.org"],
    data: "per-call",
    access: ["read"],
    readMethods: ["GET"],
    accountWidePaths: [],
    hint: "An API key from newsapi.org/register; the Gateway sends it in the X-Api-Key header. The free Developer plan allows 100 requests a day, delays articles by 24 hours and is for development only; production needs a paid plan.",
    secrets: [
      {
        name: "NEWSAPI_API_KEY",
        hint: "The API key NewsAPI shows after you register.",
      },
    ],
    cost: {
      unit: "call",
      usd: 0.0018,
      note: "Developer plan free (100 requests a day, development only); Business $449 a month for 250,000 requests, then $0.0018 each.",
    },
    rate: {
      perDay: 100,
      note: "Developer plan; Business includes 250,000 requests a month, Advanced 2,000,000.",
    },
    example: "find today's top business headlines in the US",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["news"],
  },
} as const satisfies Record<string, ApiKeyCapability>;
