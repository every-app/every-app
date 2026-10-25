import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_ORDER,
  aiDefaultCandidates,
  aiDefaultChoiceProblem,
  aiDefaultSetupHint,
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
    const resolution = resolveAiDefault({ choice: null, isSet: () => false });
    expect(resolution.provider).toBe("openrouter");
    expect(resolution.source).toBe("none");
    expect(resolution.configured).toBe(false);
    expect(resolution.settings).toEqual(["OPENROUTER_API_KEY"]);
    expect(resolution.via).toBe("direct");
    expect(resolution.model).toBe("anthropic/claude-haiku-5.5");
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual([
      ...AI_DEFAULT_ORDER,
    ]);
  });

  it("with nothing chosen: the first configured provider of the order", () => {
    const resolution = resolveAiDefault({
      choice: null,
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
      choice: { provider: "openai", model: "gpt-6-sol" },
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(resolution.provider).toBe("openai");
    expect(resolution.source).toBe("setting");
    expect(resolution.configured).toBe(false);
    expect(resolution.model).toBe("gpt-6-sol");
    expect(resolution.settings).toEqual(["OPENAI_API_KEY"]);
  });

  it("reports a choice the default can't be and lets the order decide", () => {
    const resolution = resolveAiDefault({
      choice: { provider: "cohere" },
      isSet: setOf(["OPENROUTER_API_KEY"]),
    });
    expect(resolution.provider).toBe("openrouter");
    expect(resolution.source).toBe("order");
    expect(resolution.problem).toContain("Cohere");
  });

  it("says when the call goes through AI Gateway", () => {
    const through = resolveAiDefault({
      choice: null,
      isSet: setOf([
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_ID",
        "CLOUDFLARE_ACCOUNT_ID",
      ]),
    });
    expect(through.via).toBe("ai-gateway");
    const gemini = resolveAiDefault({
      choice: { provider: "gemini" },
      isSet: setOf([
        "GEMINI_API_KEY",
        "AI_GATEWAY_ID",
        "CLOUDFLARE_ACCOUNT_ID",
      ]),
    });
    expect(gemini.via).toBe("direct");
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
      resolveAiDefault({ choice: null, isSet: () => false }),
    );
    expect(hint).toContain("set OPENROUTER_API_KEY");
    expect(hint).toContain(
      "Workers AI (WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)",
    );
    expect(hint).toContain("everyapp ai default <provider>");
  });
});
