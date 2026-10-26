/**
 * `everyapp ai …` end to end, in a fake Cloudflare account with a deployed
 * gateway (as workspace/index.test.ts): what `show` and `list` resolve
 * from the Gateway's secret names, what `default` writes (the
 * `org_settings` row, the `ai.default_changed` event, the cap column
 * untouched) and refuses, and what `gateway on|off` sets.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { cfD1Database } from "@/lib/cf/d1";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { setDefaultCap } from "../workspace/apps";
import { chooseDefault, chooseModels, listCandidates, showDefault, turnGatewayOff, turnGatewayOn } from "./index";

const GATEWAY = "every-app-gateway";
const NOW = Date.parse("2026-10-25T12:00:00Z");
const ORG = "org-acme";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const createCf = vi.fn(() => account.cf);
const opts = () => ({ flags: { json: true }, out: out(), createCf, now: () => NOW });
const sqlite = () => account.database(GATEWAY);
const rows = (sql: string, ...params: Array<string | number | null>) => sqlite().all(sql, ...params);
/** The command's own done event: the last one (a setting write emits its own first). */
const done = () => events.filter((event) => event["type"] === "done").at(-1);
const data = () => done()!["data"] as Record<string, any>;
const gatewaySecrets = () => account.workers.get(GATEWAY)!.secrets;

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  const db = sqlite().sqlite;
  const exec = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
  exec("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Acme', 'acme', ?)", ORG, NOW - 10);
  exec(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u-owner', 'Dev', 'dev@example.com', 1, ?, ?)",
    NOW - 9,
    NOW - 9,
  );
  exec("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m-owner', ?, 'u-owner', 'owner', ?)", ORG, NOW - 8);
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const aiEvents = () =>
  rows("SELECT data FROM events WHERE type = 'ai.default_changed' ORDER BY id").map((row) =>
    JSON.parse(String(row["data"])),
  );

describe("ai show and ai list", () => {
  it("resolves on the Gateway's secret names: nothing set, then the first of the order that is", async () => {
    await showDefault(opts());
    expect(data()).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      source: "none",
      configured: false,
      settings: ["OPENROUTER_API_KEY"],
      via: "direct",
      aiGateway: { on: false },
    });
    expect(data()["candidates"].map((candidate: { id: string }) => candidate.id)).toEqual([
      "openrouter",
      "workers-ai",
      "openai",
      "anthropic",
      "groq",
      "mistral",
      "gemini",
      "opper",
    ]);
    expect(done()!["message"]).toContain("Nothing is set yet");

    gatewaySecrets()["WORKERS_AI_API_TOKEN"] = "cf";
    gatewaySecrets()["CLOUDFLARE_ACCOUNT_ID"] = "acc";
    events = [];
    await showDefault(opts());
    expect(data()).toMatchObject({ provider: "workers-ai", source: "order", configured: true });
    expect(done()!["message"]).toContain("Workers AI");
  });

  it("lists the candidates with their state, the default marked", async () => {
    gatewaySecrets()["GROQ_API_KEY"] = "gsk";
    await listCandidates(opts());
    expect(data()["provider"]).toBe("groq");
    const groq = data()["candidates"].find((candidate: { id: string }) => candidate.id === "groq");
    expect(groq).toMatchObject({ configured: true, settings: ["GROQ_API_KEY"], model: "openai/gpt-oss-20b" });
    expect(done()!["message"]).toContain("← the default");
  });
});

describe("ai default", () => {
  it("writes org_settings with the choice and queues ai.default_changed once; the cap column stays", async () => {
    await setDefaultCap(opts(), 1000);
    events = [];
    await chooseDefault(opts(), "openrouter/anthropic/claude-sonnet-5.5");
    expect(rows("SELECT organization_id, default_monthly_call_cap, ai_default, ai_models, updated_by FROM org_settings")).toEqual([
      {
        organization_id: ORG,
        default_monthly_call_cap: 1000,
        ai_default: "openrouter",
        ai_models: '{"openrouter":{"chat":"anthropic/claude-sonnet-5.5"}}',
        updated_by: "u-owner",
      },
    ]);
    expect(aiEvents()).toEqual([{ aiDefault: { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" }, previous: null }]);
    expect(data()).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5", source: "setting", configured: false });
    expect(done()!["message"]).toContain("OPENROUTER_API_KEY isn't set");

    // The same choice again: nothing changes, no second event.
    events = [];
    await chooseDefault(opts(), "openrouter/anthropic/claude-sonnet-5.5");
    expect(done()!["message"]).toContain("Nothing changed");
    expect(aiEvents()).toHaveLength(1);

    // Off clears the choice, keeps the cap and the provider's model, and queues the event with the previous choice.
    events = [];
    await chooseDefault(opts(), "off");
    expect(rows("SELECT default_monthly_call_cap, ai_default, ai_models FROM org_settings")).toEqual([
      { default_monthly_call_cap: 1000, ai_default: null, ai_models: '{"openrouter":{"chat":"anthropic/claude-sonnet-5.5"}}' },
    ]);
    // The clock is fixed, so the two events don't sort: both are there.
    expect(aiEvents()).toHaveLength(2);
    expect(aiEvents()).toEqual(
      expect.arrayContaining([
        { aiDefault: null, previous: { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" } },
      ]),
    );
    expect(data()["source"]).toBe("none");
  });

  it("clearing the cap keeps the choice, and a row with neither goes", async () => {
    await chooseDefault(opts(), "groq");
    await setDefaultCap(opts(), 1000);
    await setDefaultCap(opts(), null);
    expect(rows("SELECT default_monthly_call_cap, ai_default FROM org_settings")).toEqual([
      { default_monthly_call_cap: null, ai_default: "groq" },
    ]);
    await chooseDefault(opts(), "off");
    expect(rows("SELECT * FROM org_settings")).toEqual([]);
  });

  it("refuses what the default can't be before connecting, and names the candidates", async () => {
    await expect(chooseDefault(opts(), "stripe")).rejects.toMatchObject({ code: "AI_DEFAULT_INVALID" });
    await expect(chooseDefault(opts(), "ai-gateway")).rejects.toThrow(/everyapp ai gateway on/);
    await expect(chooseDefault(opts(), "cohere")).rejects.toThrow(/chat route/);
    await expect(chooseDefault(opts(), "Open Router")).rejects.toMatchObject({ code: "AI_DEFAULT_INVALID" });
    expect(rows("SELECT * FROM org_settings")).toEqual([]);
    expect(aiEvents()).toEqual([]);
  });
});

describe("ai model", () => {
  const modelEvents = () =>
    rows("SELECT data FROM events WHERE type = 'ai.model_changed' ORDER BY id").map((row) => JSON.parse(String(row["data"])));

  it("sets a provider's models without choosing it, seed puts the catalog's back, and the row goes when empty", async () => {
    gatewaySecrets()["GROQ_API_KEY"] = "gsk";
    await chooseModels(opts(), "openrouter", { chat: "anthropic/claude-sonnet-5.5", embeddings: "openai/text-embedding-3-large" });
    expect(rows("SELECT ai_default, ai_models FROM org_settings")).toEqual([
      {
        ai_default: null,
        ai_models: '{"openrouter":{"chat":"anthropic/claude-sonnet-5.5","embeddings":"openai/text-embedding-3-large"}}',
      },
    ]);
    expect(modelEvents()).toEqual([
      {
        provider: "openrouter",
        models: { chat: "anthropic/claude-sonnet-5.5", embeddings: "openai/text-embedding-3-large" },
        previous: { chat: null, embeddings: null },
      },
    ]);
    // Groq serves (its key is set); OpenRouter's models wait for it.
    expect(data()["provider"]).toBe("groq");
    expect(done()!["message"]).toContain("once it is the default");
    const openrouter = data()["candidates"].find((candidate: { id: string }) => candidate.id === "openrouter");
    expect(openrouter).toMatchObject({
      model: "anthropic/claude-sonnet-5.5",
      embeddingsModel: "openai/text-embedding-3-large",
      seed: { chat: "anthropic/claude-haiku-5.5", embeddings: "openai/text-embedding-3-small" },
    });

    events = [];
    await chooseModels(opts(), "openrouter", { chat: "seed", embeddings: "seed" });
    expect(rows("SELECT * FROM org_settings")).toEqual([]);
    expect(modelEvents()).toHaveLength(2);
  });

  it("refuses an embeddings model on a provider without embeddings, a provider the default can't be, and no flags", async () => {
    await expect(chooseModels(opts(), "groq", { embeddings: "x" })).rejects.toThrow(/no embeddings route/);
    await expect(chooseModels(opts(), "stripe", { chat: "x" })).rejects.toMatchObject({ code: "AI_DEFAULT_INVALID" });
    await expect(chooseModels(opts(), "openrouter", {})).rejects.toMatchObject({ code: "AI_DEFAULT_INVALID" });
    expect(rows("SELECT * FROM org_settings")).toEqual([]);
  });
});

describe("ai gateway on and off", () => {
  it("finds or makes the gateway through the seam and sets AI_GATEWAY_ID; off unsets it", async () => {
    const ensureAiGateway = vi.fn(async (_cf: unknown, options: { id: string; accountId: string }) => ({
      id: options.id,
      url: `https://gateway.ai.cloudflare.com/v1/${options.accountId}/${options.id}`,
      created: true,
    }));
    await turnGatewayOn({ ...opts(), ensureAiGateway });
    expect(ensureAiGateway).toHaveBeenCalledWith(expect.anything(), { id: "everyapp", accountId: ACCOUNT_ID });
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBe("everyapp");
    expect(data()).toMatchObject({ id: "everyapp", url: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/everyapp`, created: true });

    events = [];
    await showDefault(opts());
    expect(data()["aiGateway"]).toEqual({ on: true });

    events = [];
    await turnGatewayOff(opts());
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBeUndefined();
    expect(data()).toMatchObject({ on: false, changed: true });

    events = [];
    await turnGatewayOff(opts());
    expect(data()).toMatchObject({ on: false, changed: false });
  });

  it("takes --id, lowercased, and refuses an id Cloudflare would", async () => {
    const ensureAiGateway = vi.fn(async (_cf: unknown, options: { id: string; accountId: string }) => ({
      id: options.id,
      url: `https://gateway.ai.cloudflare.com/v1/${options.accountId}/${options.id}`,
      created: false,
    }));
    await turnGatewayOn({ ...opts(), ensureAiGateway }, "Acme-Models");
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBe("acme-models");
    await expect(turnGatewayOn({ ...opts(), ensureAiGateway }, "bad--id")).rejects.toMatchObject({
      code: "AI_GATEWAY_ID_INVALID",
    });
    await expect(turnGatewayOn({ ...opts(), ensureAiGateway }, "under_score")).rejects.toMatchObject({
      code: "AI_GATEWAY_ID_INVALID",
    });
  });
});
