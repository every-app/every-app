/**
 * The DataForSEO provider app's tools: a curated set of DataForSEO's Live
 * endpoints (one POST, an answer in seconds), every one read-only, under
 * `dataforseo_<tool>` on the gateway's /mcp. Each call goes through the
 * capability proxy with the gateway's `DATAFORSEO_API_KEY` (./call.ts),
 * carries a `tag` naming the organization for DataForSEO's own usage
 * reports, and comes back as `{ cost, result }`: what the call cost in USD
 * on the operator's account, and the task's result as DataForSEO shapes it.
 *
 * Prices (2026-10-24, docs.dataforseo.com): a Google SERP $0.002 per 10
 * results; a DataForSEO Labs task $0.012 plus $0.00012 per item; a
 * Backlinks task $0.024 plus $0.000036 per row; Google Ads search volume
 * $0.09 per task of up to 1,000 keywords. Limits are capped here so one
 * answer stays well under what a tool may relay.
 *
 * In local dev (`GATEWAY_URL` on http://) `DATAFORSEO_SANDBOX=true` in the
 * gateway's .dev.vars sends every call to sandbox.dataforseo.com, which
 * answers like production with made-up data at no charge.
 */
import { env } from "cloudflare:workers";
import {
  defineTools,
  ToolError,
  type ToolContext,
} from "@every-app/sdk/server";
import { providerCall, type ProviderAnswer } from "./call";
import type { ProviderAppEnv } from "./index";
import { objectOf, type Fields } from "./schema";

const LIVE_HOST = "api.dataforseo.com";
const SANDBOX_HOST = "sandbox.dataforseo.com";

/** The host every call goes to: the sandbox only in local dev, when asked. */
function dataforseoHost(): string {
  const settings = env as unknown as Record<string, unknown>;
  const gatewayUrl =
    typeof settings["GATEWAY_URL"] === "string" ? settings["GATEWAY_URL"] : "";
  const sandbox = settings["DATAFORSEO_SANDBOX"];
  return gatewayUrl.startsWith("http://") && sandbox === "true"
    ? SANDBOX_HOST
    : LIVE_HOST;
}

const DEFAULT_LOCATION_CODE = 2840;

const LOCATION: Fields = {
  location_code: {
    type: "integer",
    description:
      "DataForSEO location code: 2840 United States (the default), 2826 United Kingdom, 2124 Canada, 2036 Australia, 2276 Germany, 2250 France, 2724 Spain, 2380 Italy, 2528 Netherlands, 2356 India, 2076 Brazil. Or give location_name instead.",
    minimum: 1,
  },
  location_name: {
    type: "string",
    description:
      'A location by name instead of location_code, as DataForSEO names it: "United States", "London,England,United Kingdom".',
    maxLength: 200,
  },
};

const LANGUAGE: Fields = {
  language_code: {
    type: "string",
    description:
      "Two-letter language code: en (the default), de, fr, es, it, nl, pt.",
    default: "en",
    maxLength: 10,
  },
};

const limitField = (max: number, fallback: number): Fields => ({
  limit: {
    type: "integer",
    description: `How many results to return, 1 to ${max} (each result adds to the cost). Default ${fallback}.`,
    minimum: 1,
    maximum: max,
    default: fallback,
  },
});

const keywordsField = (max: number, what: string): Fields => ({
  keywords: {
    type: "array",
    description: `${what}, 1 to ${max} per call (one call for many keywords costs far less than many calls).`,
    items: { type: "string", maxLength: 700 },
    minItems: 1,
    maxItems: max,
  },
});

const KEYWORD: Fields = {
  keyword: {
    type: "string",
    description: "The keyword or search query.",
    maxLength: 700,
  },
};

const TARGET: Fields = {
  target: {
    type: "string",
    description: 'A domain without protocol ("example.com") or a page URL.',
    maxLength: 2000,
  },
};

interface Located {
  location_code?: number;
  location_name?: string;
}

/** Where a task looks: the code or the name given, else the United States. */
function where(
  input: Located,
): { location_code: number } | { location_name: string } {
  if (input.location_name) return { location_name: input.location_name };
  return { location_code: input.location_code ?? DEFAULT_LOCATION_CODE };
}

interface Envelope {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: unknown;
  }>;
}

/** A provider message as one sentence: its own full stop, not two. */
const sentence = (text: string) => text.replace(/\.+$/, "");

/** The task's result and the call's cost, or the provider's error as a tool error. */
function unwrap(answer: ProviderAnswer): {
  cost: number | null;
  result: unknown;
} {
  const body = (answer.body ?? {}) as Envelope;
  if (
    answer.status >= 400 ||
    (body.status_code !== undefined && body.status_code !== 20000)
  ) {
    throw new ToolError(
      `DataForSEO answered ${body.status_code ?? answer.status}: ${sentence(body.status_message ?? "no message")}.`,
    );
  }
  const task = body.tasks?.[0];
  if (!task) throw new ToolError("DataForSEO answered without a task.");
  if (task.status_code !== undefined && task.status_code !== 20000) {
    throw new ToolError(
      `DataForSEO: ${sentence(task.status_message ?? "task failed")} (${task.status_code}).`,
    );
  }
  return {
    cost: typeof body.cost === "number" ? body.cost : null,
    result: task.result ?? null,
  };
}

/** One Live task, tagged with the organization, through the capability proxy. */
async function live(
  context: ToolContext,
  path: string,
  task: Record<string, unknown>,
): Promise<{ cost: number | null; result: unknown }> {
  const provider = context as unknown as ToolContext<ProviderAppEnv>;
  const answer = await providerCall(provider, {
    host: dataforseoHost(),
    path,
    body: [
      { ...task, tag: `everyapp:${provider.env.PROVIDER_APP.organizationId}` },
    ],
  });
  return unwrap(answer);
}

type Lang = { language_code: string };
type Limited = { limit: number };

const LABS = "/v3/dataforseo_labs/google";

export const dataforseoTools = defineTools(
  {
    serp_google: {
      title: "Google search results",
      description:
        "Live Google organic results for a query: the ranked pages (title, URL, description, position) and SERP features such as people-also-ask, featured snippets and the local pack. $0.002 per 10 results.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<
        Located & Lang & { keyword: string; depth: number; device: string }
      >(
        {
          ...KEYWORD,
          ...LOCATION,
          ...LANGUAGE,
          depth: {
            type: "integer",
            description:
              "How many results, a multiple of 10 from 10 to 100. Default 10.",
            minimum: 10,
            maximum: 100,
            default: 10,
          },
          device: {
            type: "string",
            description: "desktop (the default) or mobile.",
            enum: ["desktop", "mobile"],
            default: "desktop",
          },
        },
        ["keyword"],
      ),
      handler: (input, context) =>
        live(context, "/v3/serp/google/organic/live/advanced", {
          keyword: input.keyword,
          ...where(input),
          language_code: input.language_code,
          depth: input.depth,
          device: input.device,
        }),
    },
    serp_google_maps: {
      title: "Google Maps results",
      description:
        "Live Google Maps results for a query: businesses with name, address, rating, reviews count and category. $0.002 per 10 results.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { keyword: string; depth: number }>(
        {
          ...KEYWORD,
          ...LOCATION,
          ...LANGUAGE,
          depth: {
            type: "integer",
            description:
              "How many results, a multiple of 10 from 10 to 100. Default 10.",
            minimum: 10,
            maximum: 100,
            default: 10,
          },
        },
        ["keyword"],
      ),
      handler: (input, context) =>
        live(context, "/v3/serp/google/maps/live/advanced", {
          keyword: input.keyword,
          ...where(input),
          language_code: input.language_code,
          depth: input.depth,
        }),
    },
    serp_google_autocomplete: {
      title: "Google autocomplete",
      description:
        "What Google suggests while typing a query: the autocomplete phrases, in order. $0.002 per call.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { keyword: string }>(
        { ...KEYWORD, ...LOCATION, ...LANGUAGE },
        ["keyword"],
      ),
      handler: (input, context) =>
        live(context, "/v3/serp/google/autocomplete/live/advanced", {
          keyword: input.keyword,
          ...where(input),
          language_code: input.language_code,
        }),
    },
    keyword_search_volume: {
      title: "Search volume (Google Ads)",
      description:
        "Google Ads search volume, competition and CPC for up to 200 keywords in one call: monthly searches and the last 12 months. $0.09 per call, whatever the number of keywords.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { keywords: string[] }>(
        {
          keywords: {
            type: "array",
            description:
              "The keywords, 1 to 200 per call, each at most 80 characters and 10 words, without symbols or emoji (Google Ads refuses them).",
            items: { type: "string", maxLength: 80 },
            minItems: 1,
            maxItems: 200,
          },
          ...LOCATION,
          ...LANGUAGE,
        },
        ["keywords"],
      ),
      handler: (input, context) =>
        live(context, "/v3/keywords_data/google_ads/search_volume/live", {
          keywords: input.keywords,
          ...where(input),
          language_code: input.language_code,
        }),
    },
    keyword_overview: {
      title: "Keyword overview",
      description:
        "DataForSEO Labs metrics for up to 100 keywords in one call: search volume, keyword difficulty, CPC, competition, search intent and SERP features. $0.012 per call plus $0.00012 per keyword.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { keywords: string[] }>(
        { ...keywordsField(100, "The keywords"), ...LOCATION, ...LANGUAGE },
        ["keywords"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/keyword_overview/live`, {
          keywords: input.keywords,
          ...where(input),
          language_code: input.language_code,
        }),
    },
    keyword_suggestions: {
      title: "Keyword suggestions",
      description:
        "Long-tail keywords that contain the seed keyword, with search volume, difficulty and CPC. $0.012 per call plus $0.00012 per result.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & Limited & { keyword: string }>(
        { ...KEYWORD, ...LOCATION, ...LANGUAGE, ...limitField(100, 20) },
        ["keyword"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/keyword_suggestions/live`, {
          keyword: input.keyword,
          ...where(input),
          language_code: input.language_code,
          limit: input.limit,
        }),
    },
    keyword_ideas: {
      title: "Keyword ideas",
      description:
        "Keywords from the same topic as the seed keywords (not only ones containing them), with search volume, difficulty and CPC. $0.012 per call plus $0.00012 per result.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & Limited & { keywords: string[] }>(
        {
          ...keywordsField(20, "The seed keywords"),
          ...LOCATION,
          ...LANGUAGE,
          ...limitField(100, 20),
        },
        ["keywords"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/keyword_ideas/live`, {
          keywords: input.keywords,
          ...where(input),
          language_code: input.language_code,
          limit: input.limit,
        }),
    },
    related_keywords: {
      title: "Related keywords",
      description:
        'Keywords from Google\'s "searches related to" for the seed keyword, with search volume, difficulty and CPC. $0.012 per call plus $0.00012 per result.',
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<
        Located & Lang & Limited & { keyword: string; depth: number }
      >(
        {
          ...KEYWORD,
          ...LOCATION,
          ...LANGUAGE,
          depth: {
            type: "integer",
            description:
              "How many levels of related searches to follow, 0 to 3. Default 1.",
            minimum: 0,
            maximum: 3,
            default: 1,
          },
          ...limitField(100, 20),
        },
        ["keyword"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/related_keywords/live`, {
          keyword: input.keyword,
          ...where(input),
          language_code: input.language_code,
          depth: input.depth,
          limit: input.limit,
        }),
    },
    keyword_difficulty: {
      title: "Keyword difficulty",
      description:
        "Keyword difficulty (0 to 100) for up to 200 keywords in one call: how hard it is to rank in the top 10. $0.012 per call plus $0.00012 per keyword.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { keywords: string[] }>(
        { ...keywordsField(200, "The keywords"), ...LOCATION, ...LANGUAGE },
        ["keywords"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/bulk_keyword_difficulty/live`, {
          keywords: input.keywords,
          ...where(input),
          language_code: input.language_code,
        }),
    },
    search_intent: {
      title: "Search intent",
      description:
        "The search intent (informational, navigational, commercial, transactional) with a probability for up to 200 keywords in one call. $0.012 per call plus $0.00012 per keyword.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<{ keywords: string[] }>(
        { ...keywordsField(200, "The keywords") },
        ["keywords"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/search_intent/live`, {
          keywords: input.keywords,
        }),
    },
    ranked_keywords: {
      title: "Keywords a domain ranks for",
      description:
        "The keywords a domain or page ranks for in Google, with position, search volume, estimated traffic and the ranking URL. $0.012 per call plus $0.00012 per result.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & Limited & { target: string }>(
        { ...TARGET, ...LOCATION, ...LANGUAGE, ...limitField(100, 20) },
        ["target"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/ranked_keywords/live`, {
          target: input.target,
          ...where(input),
          language_code: input.language_code,
          limit: input.limit,
        }),
    },
    domain_rank_overview: {
      title: "Domain rank overview",
      description:
        "A domain's organic and paid search footprint in Google: ranking keyword counts by position, estimated traffic value and visibility. $0.012 per call.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & { target: string }>(
        { ...TARGET, ...LOCATION, ...LANGUAGE },
        ["target"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/domain_rank_overview/live`, {
          target: input.target,
          ...where(input),
          language_code: input.language_code,
        }),
    },
    competitors_domain: {
      title: "Competing domains",
      description:
        "Domains that rank for the same keywords as the target, with how many keywords they share and their traffic estimates. $0.012 per call plus $0.00012 per result.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Located & Lang & Limited & { target: string }>(
        { ...TARGET, ...LOCATION, ...LANGUAGE, ...limitField(100, 20) },
        ["target"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/competitors_domain/live`, {
          target: input.target,
          ...where(input),
          language_code: input.language_code,
          limit: input.limit,
        }),
    },
    domain_intersection: {
      title: "Keywords two domains share",
      description:
        "Keywords both domains rank for, with each one's position, search volume and difficulty: the gap between you and a competitor. $0.012 per call plus $0.00012 per result.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<
        Located & Lang & Limited & { target1: string; target2: string }
      >(
        {
          target1: {
            type: "string",
            description: "The first domain, without protocol.",
            maxLength: 2000,
          },
          target2: {
            type: "string",
            description: "The second domain, without protocol.",
            maxLength: 2000,
          },
          ...LOCATION,
          ...LANGUAGE,
          ...limitField(100, 20),
        },
        ["target1", "target2"],
      ),
      handler: (input, context) =>
        live(context, `${LABS}/domain_intersection/live`, {
          target1: input.target1,
          target2: input.target2,
          ...where(input),
          language_code: input.language_code,
          limit: input.limit,
        }),
    },
    backlinks_summary: {
      title: "Backlinks summary",
      description:
        "A domain's or page's backlink profile in one answer: backlinks, referring domains, dofollow share, rank, spam score, anchors and the history of new and lost links. $0.024 per call.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<{ target: string }>({ ...TARGET }, ["target"]),
      handler: (input, context) =>
        live(context, "/v3/backlinks/summary/live", { target: input.target }),
    },
    backlinks: {
      title: "Backlinks",
      description:
        "The pages linking to a domain or page: the linking URL, anchor, dofollow or not, the linking domain's rank and when the link was seen. $0.024 per call plus $0.000036 per row.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Limited & { target: string; mode: string }>(
        {
          ...TARGET,
          mode: {
            type: "string",
            description:
              "as_is (every backlink), one_per_domain (the default: one per linking domain) or one_per_anchor.",
            enum: ["as_is", "one_per_domain", "one_per_anchor"],
            default: "one_per_domain",
          },
          ...limitField(100, 20),
        },
        ["target"],
      ),
      handler: (input, context) =>
        live(context, "/v3/backlinks/backlinks/live", {
          target: input.target,
          mode: input.mode,
          limit: input.limit,
        }),
    },
    referring_domains: {
      title: "Referring domains",
      description:
        "The domains linking to a target, each with its backlink count, rank, first and last seen. $0.024 per call plus $0.000036 per row.",
      risk: "read",
      idempotent: true,
      openWorld: true,
      input: objectOf<Limited & { target: string }>(
        { ...TARGET, ...limitField(100, 20) },
        ["target"],
      ),
      handler: (input, context) =>
        live(context, "/v3/backlinks/referring_domains/live", {
          target: input.target,
          limit: input.limit,
        }),
    },
  },
  {
    instructions:
      "SEO data from DataForSEO through the gateway's key: every call is paid from the operator's DataForSEO balance (cents per call; the price is in each tool's description and the answer's `cost` is what it cost in USD). Batch keywords into one call where a tool takes a list, keep `limit` small, and don't repeat a call you already have the answer to. Locations default to the United States (location_code 2840); languages to en.",
  },
);
