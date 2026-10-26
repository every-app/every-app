/**
 * `everyapp provider add <ai spec>`: an OpenAI-compatible model provider
 * registered as a row, what the command says next, `provider show` and
 * `--save` for it, in the fake Cloudflare account with a deployed gateway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { addFromSpec, showProvider } from "./index";

const VENDOR = {
  id: "vendor-ai",
  mode: "ai",
  name: "Vendor AI",
  docs: "https://vendor.example/keys",
  baseUrl: "https://api.vendor.example/openai",
  auth: { kind: "bearer", secret: "VENDOR_AI_API_KEY" },
  models: ["v-chat"],
  defaultModel: "v-chat",
};

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];
const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const createCf = vi.fn(() => account.cf);
const done = () => events.find((event) => event["type"] === "done");

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
    sleep: async () => undefined,
    leaseWaitMs: 0,
  });
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function appDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-ai-spec-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "vendor.json"), JSON.stringify(VENDOR));
  fs.writeFileSync(path.join(dir, "everyapp.config.ts"), 'export default { id: "shop" };\n');
  return dir;
}

describe("provider add with an ai spec", () => {
  it("registers the row, says where the key goes and how apps list it, and show --save writes it back", async () => {
    const cwd = appDir();
    await addFromSpec({ flags, out: out(), cwd, createCf }, "vendor.json");
    expect(done()?.["data"]).toMatchObject({
      id: "vendor-ai",
      name: "Vendor AI",
      hosts: ["api.vendor.example"],
      settings: ["VENDOR_AI_API_KEY"],
      source: "row",
      devFile: ".everyapp/providers/vendor-ai.json",
    });
    expect(done()?.["message"]).toContain("Its key goes to https://api.vendor.example/openai only, as a bearer token.");
    expect(done()?.["message"]).toContain('Apps list it under providers: [{ id: "vendor-ai", why: "..." }]');
    fs.rmSync(path.join(cwd, ".everyapp"), { recursive: true });
    events = [];
    await showProvider({ flags: { ...flags, save: true }, out: out(), cwd, createCf }, "vendor-ai");
    expect(done()?.["data"]).toMatchObject({
      provider: { mode: "ai", baseUrl: "https://api.vendor.example/openai", models: ["v-chat"], defaultModel: "v-chat" },
      source: "row",
      bound: false,
      saved: ".everyapp/providers/vendor-ai.json",
    });
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".everyapp/providers/vendor-ai.json"), "utf8"));
    expect(saved).toMatchObject({ id: "vendor-ai", mode: "ai", routes: ["/v1/chat/completions"] });
  });
});
