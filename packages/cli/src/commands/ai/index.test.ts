/**
 * `everyapp ai gateway on|off` end to end, in a fake Cloudflare account
 * with a deployed gateway: the part of `ai` that stays a Cloudflare job
 * under the login (the rest are Gateway tools, tested on the Gateway). It
 * finds or makes the AI Gateway and sets or unsets AI_GATEWAY_ID.
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
import { turnGatewayOff, turnGatewayOn } from "./index";

const GATEWAY = "every-app-gateway";

let account: FakeCloudflare;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const createCf = vi.fn(() => account.cf);
const opts = () => ({ flags: { json: true }, out: out(), createCf });
/** The command's own done event: the last one (a setting write emits its own first). */
const data = () => events.filter((event) => event["type"] === "done").at(-1)!["data"] as Record<string, any>;
const gatewaySecrets = () => account.workers.get(GATEWAY)!.secrets;
const fakeEnsure = (created: boolean) =>
  vi.fn(async (_cf: unknown, options: { id: string; accountId: string }) => ({
    id: options.id,
    url: `https://gateway.ai.cloudflare.com/v1/${options.accountId}/${options.id}`,
    created,
  }));

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  release = await openRelease(await buildGatewayRelease());
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
    sleep: async () => undefined,
    leaseWaitMs: 0,
  });
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ai gateway on and off", () => {
  it("finds or makes the gateway through the seam and sets AI_GATEWAY_ID; off unsets it", async () => {
    const ensureAiGateway = fakeEnsure(true);
    await turnGatewayOn({ ...opts(), ensureAiGateway });
    expect(ensureAiGateway).toHaveBeenCalledWith(expect.anything(), { id: "everyapp", accountId: ACCOUNT_ID });
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBe("everyapp");
    expect(data()).toMatchObject({ id: "everyapp", url: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/everyapp`, created: true });

    events = [];
    await turnGatewayOff(opts());
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBeUndefined();
    expect(data()).toMatchObject({ on: false, changed: true });

    events = [];
    await turnGatewayOff(opts());
    expect(data()).toMatchObject({ on: false, changed: false });
  });

  it("takes --id, lowercased, and refuses an id Cloudflare would", async () => {
    const ensureAiGateway = fakeEnsure(false);
    await turnGatewayOn({ ...opts(), ensureAiGateway }, "Acme-Models");
    expect(gatewaySecrets()["AI_GATEWAY_ID"]).toBe("acme-models");
    for (const bad of ["bad--id", "under_score"]) {
      await expect(turnGatewayOn({ ...opts(), ensureAiGateway }, bad)).rejects.toMatchObject({ code: "AI_GATEWAY_ID_INVALID" });
    }
  });
});
