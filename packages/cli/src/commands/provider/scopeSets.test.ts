/**
 * `everyapp provider scope-set add|remove` end to end, in a fake Cloudflare
 * account with a deployed gateway (its D1 a real SQLite with the gateway's
 * migrations, `provider_scope_sets` included): the row each writes, every
 * refusal before anything is written, what `provider show` then reports,
 * and that the registry `deploy` validates against serves the set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { gatewayRegistry } from "@/lib/gateway/providers";
import { register } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { showProvider } from "./index";
import { addScopeSetCommand, removeScopeSetCommand } from "./scopeSets";

const GATEWAY = "every-app-gateway";

const GMAIL_SEND = {
  name: "gmail.send",
  label: "Gmail (send)",
  access: "write",
  scopes: ["https://www.googleapis.com/auth/gmail.send"],
  routes: [
    {
      host: "gmail.googleapis.com",
      paths: ["/gmail/v1/users/"],
      posts: ["^/gmail/v1/users/[^/]+/messages/send$"],
    },
  ],
};

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const done = () => events.find((event) => event["type"] === "done");
const createCf = vi.fn(() => account.cf);

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
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory holding `spec` as gmail-send.json. */
function specDir(spec: unknown, name = "gmail-send.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-scope-set-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(spec));
  return dir;
}

const add = (provider: string, spec: unknown, options: { replace?: boolean } = {}) =>
  addScopeSetCommand(
    { flags: { ...flags, replace: options.replace }, out: out(), cwd: specDir(spec), createCf },
    provider,
    "gmail-send.json",
  );
const remove = (provider: string, name: string, force = false) =>
  removeScopeSetCommand({ flags: { ...flags, force }, out: out(), createCf }, provider, name);
const show = (id: string) => showProvider({ flags, out: out(), cwd: os.tmpdir(), createCf }, id);

const rows = async () =>
  (await db().run([{ sql: "SELECT provider_id, name, spec, added_by FROM provider_scope_sets ORDER BY name" }]))[0] ?? [];

async function registerApp(id: string, manifest: Record<string, unknown>) {
  await register(db(), {
    appSlug: id,
    name: id,
    description: id,
    manifest: { id, ...manifest },
    appBaseDomain: "example.com",
    deployer: { actor: "dev@example.com", email: "dev@example.com" },
    organizationName: "Acme",
  });
}

describe("provider scope-set add", () => {
  it("writes the row under the login, and the registry serves the set on the client", async () => {
    await add("google-workspace", GMAIL_SEND);
    expect(done()?.["data"]).toMatchObject({
      provider: "google-workspace",
      scopeSet: { name: "gmail.send", access: "write", hosts: ["gmail.googleapis.com"], source: "row" },
      replaced: false,
      console: "https://console.cloud.google.com/apis/credentials",
    });
    expect(done()?.["message"]).toMatch(/Added the scope set gmail.send \(Gmail \(send\)\) on Google/);
    expect(await rows()).toEqual([
      expect.objectContaining({ provider_id: "google-workspace", name: "gmail.send", added_by: expect.any(String) }),
    ]);
    const registry = await gatewayRegistry(db(), { gatewayHost: "example.com", appBaseDomain: "example.com" });
    const google = registry.get("google-workspace");
    if (google?.mode !== "oauth_client") throw new Error("google");
    expect(google.scopePolicy!.sets["gmail.send"]?.access).toBe("write");
    expect(google.authorize.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(registry.scopeSetSource("google-workspace", "gmail.send")).toBe("row");

    // `provider show` lists the client's sets with where each is from.
    events = [];
    await show("google-workspace");
    const sets = (done()?.["data"] as { provider: { scopeSets: { name: string; source: string }[] } }).provider.scopeSets;
    expect(sets.find((set) => set.name === "gmail.send")?.source).toBe("row");
    expect(sets.find((set) => set.name === "gmail.read")?.source).toBe("catalog");
    expect(done()?.["message"]).not.toContain("gmail.send");
  });

  it("refuses a built-in name, a host outside the client, a bad spec, a client without sets, and a second add without --replace", async () => {
    await expect(add("google-workspace", { ...GMAIL_SEND, name: "gmail.read" })).rejects.toMatchObject({
      code: "SCOPE_SET_BUILTIN",
    });
    await expect(
      add("google-workspace", { ...GMAIL_SEND, routes: [{ host: "evil.example", paths: ["/"] }] }),
    ).rejects.toMatchObject({ code: "SCOPE_SET_INVALID", message: expect.stringContaining("must be one of hosts") });
    await expect(add("google-workspace", { ...GMAIL_SEND, access: "all" })).rejects.toMatchObject({
      code: "SCOPE_SET_INVALID",
      message: expect.stringContaining("(set).access: must be read or write"),
    });
    await expect(add("linkedin", GMAIL_SEND)).rejects.toMatchObject({ code: "SCOPE_SET_PROVIDER_UNKNOWN" });
    await expect(add("dataforseo", GMAIL_SEND)).rejects.toMatchObject({ code: "SCOPE_SET_PROVIDER_UNKNOWN" });
    expect(await rows()).toEqual([]);
    await add("google-workspace", GMAIL_SEND);
    await expect(add("google-workspace", { ...GMAIL_SEND, access: "read" })).rejects.toMatchObject({
      code: "SCOPE_SET_EXISTS",
      authorize: true,
    });
    events = [];
    await add("google-workspace", { ...GMAIL_SEND, access: "read" }, { replace: true });
    expect(done()?.["data"]).toMatchObject({ replaced: true, scopeSet: { access: "read" } });
    expect((await rows()).length).toBe(1);
  });
});

describe("provider scope-set remove", () => {
  it("deletes the row; refuses the client's own set, an unknown one, and one an app lists unless --force", async () => {
    await add("google-workspace", GMAIL_SEND);
    await expect(remove("google-workspace", "gmail.read")).rejects.toMatchObject({ code: "SCOPE_SET_BUILTIN" });
    await expect(remove("google-workspace", "nothing.read")).rejects.toMatchObject({ code: "SCOPE_SET_NOT_FOUND" });
    await registerApp("mailer", {
      capabilities: { "google-workspace": { access: "write", scopes: ["gmail.send"], why: "Sends mail." } },
    });
    await expect(remove("google-workspace", "gmail.send")).rejects.toMatchObject({
      code: "SCOPE_SET_IN_USE",
      authorize: true,
      message: expect.stringContaining("mailer lists gmail.send"),
    });
    expect((await rows()).length).toBe(1);
    events = [];
    await remove("google-workspace", "gmail.send", true);
    expect(done()?.["data"]).toMatchObject({ provider: "google-workspace", name: "gmail.send", removed: true, apps: ["mailer"] });
    expect(await rows()).toEqual([]);
  });
});
