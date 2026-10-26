import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_ORDER,
  aiDefaultCandidates,
  aiDefaultChoiceProblem,
  aiDefaultSetupHint,
  aiModelPatchProblem,
  formatAiModelSettings,
  isAiModelName,
  parseAiDefaultProvider,
  parseAiModelSettings,
  withAiModelSetting,
  aiRequiredSettings,
  canBeAiDefault,
  formatAiDefaultChoice,
  parseAiDefaultChoice,
  resolveAiDefault,
} from "./aiDefault.js";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  type Capability,
} from "./capabilities.js";

const setOf = (names: string[]) => (name: string) => names.includes(name);

describe("parseAiDefaultChoice", () => {
  it("reads a provider, or a provider and a model with slashes of its own", () => {
    expect(parseAiDefaultChoice("openrouter")).toEqual({
      provider: "openrouter",
    });
    expect(
      parseAiDefaultChoice(" openrouter/anthropic/claude-haiku-5.5 "),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
    });
    expect(
      formatAiDefaultChoice({ provider: "groq", model: "openai/gpt-oss-20b" }),
    ).toBe("groq/openai/gpt-oss-20b");
  });

  it("answers null for blank, malformed or absent text", () => {
    expect(parseAiDefaultChoice(null)).toBeNull();
    expect(parseAiDefaultChoice("")).toBeNull();
    expect(parseAiDefaultChoice("Open Router")).toBeNull();
    expect(parseAiDefaultChoice("/model")).toBeNull();
  });
});

describe("the catalog's AI entries", () => {
  it("has every provider of the shipped order, each with a chat route", () => {
    for (const id of AI_DEFAULT_ORDER) {
      const capability = CAPABILITIES[id as keyof typeof CAPABILITIES];
      expect(canBeAiDefault(capability), id).toBe(true);
    }
  });

  it("maps every chat and embeddings route onto one of the entry's inference routes", () => {
    for (const id of CAPABILITY_IDS) {
      const capability: Capability = CAPABILITIES[id];
      if (capability.mode !== "ai") continue;
      for (const route of [capability.chat, capability.embeddings]) {
        if (!route) continue;
        expect(capability.inferenceRoutes, `${id} ${route.path}`).toContain(
          route.path,
        );
      }
    }
  });

  it("never lets the proxy entry be the default, and needs no key for it", () => {
    const aig = CAPABILITIES["ai-gateway"];
    expect(canBeAiDefault(aig)).toBe(false);
    expect(aiRequiredSettings(aig)).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "AI_GATEWAY_ID",
    ]);
    expect(aiDefaultChoiceProblem({ provider: "ai-gateway" })).toContain(
      "everyapp ai gateway on",
    );
  });

  it("names the problem with a choice the default can't be", () => {
    expect(aiDefaultChoiceProblem({ provider: "stripe" })).toContain(
      "API provider",
    );
    expect(aiDefaultChoiceProblem({ provider: "cohere" })).toContain(
      "chat route",
    );
    expect(aiDefaultChoiceProblem({ provider: "nope" })).toContain(
      "isn't a provider",
    );
    expect(aiDefaultChoiceProblem({ provider: "openrouter" })).toBeNull();
  });
});

describe("resolveAiDefault", () => {
  it("with nothing chosen and nothing set: the first of the order, unconfigured, with what to set", () => {
    const resolution = resolveAiDefault({ provider: null, isSet: () => false });
    expect(resolution.provider).toBe("openrouter");
    expect(resolution.source).toBe("none");
    expect(resolution.configured).toBe(false);
    expect(resolution.settings).toEqual(["OPENROUTER_API_KEY"]);
    expect(resolution.via).toBe("direct");
    expect(resolution.model).toBe("anthropic/claude-haiku-5.5");
    // Then every other entry with a chat route, after the shipped order.
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual([
      ...AI_DEFAULT_ORDER,
      "opper",
    ]);
  });

  it("with nothing chosen: the first configured provider of the order", () => {
    const resolution = resolveAiDefault({
      provider: null,
      isSet: setOf([
        "WORKERS_AI_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "OPENAI_API_KEY",
      ]),
    });
    expect(resolution.provider).toBe("workers-ai");
    expect(resolution.source).toBe("order");
    expect(resolution.configured).toBe(true);
    expect(resolution.candidates[0]!.id).toBe("workers-ai");
  });

  it("takes the choice over the order, even when it isn't configured", () => {
    const resolution = resolveAiDefault({
      provider: "openai",
      models: { openai: { chat: "gpt-6-sol" } },
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(resolution.provider).toBe("openai");
    expect(resolution.source).toBe("setting");
    expect(resolution.configured).toBe(false);
    expect(resolution.model).toBe("gpt-6-sol");
    expect(resolution.embeddingsModel).toBe("text-embedding-3-small");
    expect(resolution.settings).toEqual(["OPENAI_API_KEY"]);
  });

  it("serves the operator's models for the provider, else the seeds", () => {
    const seeded = resolveAiDefault({
      provider: null,
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(seeded.model).toBe(seeded.seed.chat);
    expect(seeded.embeddingsModel).toBe(seeded.seed.embeddings);
    const set = resolveAiDefault({
      provider: null,
      models: {
        openrouter: { embeddings: "openai/text-embedding-3-large" },
        groq: { chat: "openai/gpt-oss-120b" },
      },
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(set.source).toBe("order");
    expect(set.model).toBe("anthropic/claude-haiku-5.5");
    expect(set.embeddingsModel).toBe("openai/text-embedding-3-large");
    expect(set.seed).toEqual({
      chat: "anthropic/claude-haiku-5.5",
      embeddings: "openai/text-embedding-3-small",
    });
    const groq = set.candidates.find((candidate) => candidate.id === "groq")!;
    expect(groq.model).toBe("openai/gpt-oss-120b");
    expect(groq.seed).toEqual({ chat: "openai/gpt-oss-20b" });
    expect(groq.embeddingsModel).toBeUndefined();
  });

  it("reports a choice the default can't be and lets the order decide", () => {
    const resolution = resolveAiDefault({
      provider: "cohere",
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(resolution.provider).toBe("openrouter");
    expect(resolution.source).toBe("order");
    expect(resolution.problem).toContain("Cohere");
  });

  it("says when the call goes through AI Gateway", () => {
    const through = resolveAiDefault({
      provider: null,
      isSet: setOf([
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_ID",
        "CLOUDFLARE_ACCOUNT_ID",
      ]),
    });
    expect(through.via).toBe("ai-gateway");
    const gemini = resolveAiDefault({
      provider: "gemini",
      isSet: setOf([
        "GEMINI_API_KEY",
        "AI_GATEWAY_ID",
        "CLOUDFLARE_ACCOUNT_ID",
      ]),
    });
    expect(gemini.via).toBe("direct");
  });

  it("takes an entry after the shipped order when its key is the only one set", () => {
    const resolution = resolveAiDefault({
      provider: null,
      isSet: setOf(["OPPER_API_KEY"]),
    });
    expect(resolution.provider).toBe("opper");
    expect(resolution.source).toBe("order");
    expect(resolution.configured).toBe(true);
    expect(resolution.settings).toEqual(["OPPER_API_KEY"]);
    expect(resolution.model).toBe("gpt-5.4-mini");
    expect(resolution.embeddingsModel).toBe("text-embedding-3-small");
    expect(resolution.via).toBe("direct");
  });

  it("lists every candidate with its state", () => {
    const candidates = aiDefaultCandidates(setOf(["GROQ_API_KEY"]));
    expect(
      candidates.find((candidate) => candidate.id === "groq")?.configured,
    ).toBe(true);
    expect(
      candidates.find((candidate) => candidate.id === "openrouter")?.configured,
    ).toBe(false);
    expect(candidates.some((candidate) => candidate.id === "ai-gateway")).toBe(
      false,
    );
    expect(candidates.some((candidate) => candidate.id === "cohere")).toBe(
      false,
    );
  });

  it("writes the setup sentence: the one key, then the alternatives", () => {
    const hint = aiDefaultSetupHint(
      resolveAiDefault({ provider: null, isSet: () => false }),
    );
    expect(hint).toContain("set OPENROUTER_API_KEY");
    expect(hint).toContain(
      "Workers AI (WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)",
    );
    expect(hint).toContain("everyapp ai default <provider>");
  });
});

describe("the model settings", () => {
  it("reads what was stored and drops what isn't a model setting", () => {
    expect(parseAiModelSettings(null)).toEqual({});
    expect(parseAiModelSettings("not json")).toEqual({});
    expect(parseAiModelSettings("[1]")).toEqual({});
    expect(
      parseAiModelSettings(
        JSON.stringify({
          openrouter: { chat: "anthropic/claude-sonnet-5.5", other: "x" },
          groq: { chat: " padded " },
          openai: "gpt-6-sol",
        }),
      ),
    ).toEqual({ openrouter: { chat: "anthropic/claude-sonnet-5.5" } });
  });

  it("formats sorted, and null when empty", () => {
    expect(formatAiModelSettings({})).toBeNull();
    expect(
      formatAiModelSettings({
        openrouter: { embeddings: "e" },
        groq: { chat: "c" },
      }),
    ).toBe('{"groq":{"chat":"c"},"openrouter":{"embeddings":"e"}}');
  });

  it("patches one provider: a name sets, null puts the seed back, absent leaves it", () => {
    const one = withAiModelSetting({}, "openrouter", {
      chat: "a",
      embeddings: "b",
    });
    expect(one).toEqual({ openrouter: { chat: "a", embeddings: "b" } });
    const two = withAiModelSetting(one, "openrouter", { chat: null });
    expect(two).toEqual({ openrouter: { embeddings: "b" } });
    expect(withAiModelSetting(two, "openrouter", { embeddings: null })).toEqual(
      {},
    );
  });

  it("refuses what can't be stored", () => {
    expect(aiModelPatchProblem("openrouter", { chat: "x" })).toBeNull();
    expect(aiModelPatchProblem("stripe", { chat: "x" })).toContain(
      "API provider",
    );
    expect(aiModelPatchProblem("groq", { embeddings: "x" })).toContain(
      "no embeddings route",
    );
    expect(aiModelPatchProblem("openrouter", { chat: " x" })).toContain(
      "isn't a model id",
    );
    expect(isAiModelName("@cf/baai/bge-m3")).toBe(true);
    expect(isAiModelName("")).toBe(false);
  });

  it("reads the stored provider alone", () => {
    expect(parseAiDefaultProvider("openrouter")).toBe("openrouter");
    expect(parseAiDefaultProvider("openrouter/anthropic/x")).toBe("openrouter");
    expect(parseAiDefaultProvider(null)).toBeNull();
  });
});
