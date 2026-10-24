/**
 * `everyapp workspace rename` end to end, in a fake Cloudflare account
 * with a deployed gateway (as provider/index.test.ts): the row, the slug
 * kept, the `done` event, a name refused before any login, and a Gateway
 * nobody has claimed.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { renameWorkspace } from "./index";

const GATEWAY = "every-app-gateway";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

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
  createCf.mockClear();
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
});

/** An organization as the setup claim leaves it: named after its owner, with one. */
async function claimed(name = "Ben Owner", slug = "ben-owner"): Promise<string> {
  const id = `org-${slug}`;
  await db().run([
    {
      sql: "INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
      params: [id, name, slug, 1000],
    },
    {
      sql: "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
      params: ["user-owner", name, "owner@example.com"],
    },
    {
      sql: "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', 0)",
      params: ["member-owner", id, "user-owner"],
    },
  ]);
  return id;
}

const rows = async () =>
  (await db().run([{ sql: "SELECT id, name, slug FROM organizations ORDER BY created_at" }]))[0] ?? [];

describe("workspace rename", () => {
  it("writes the name on the install's organization, keeps its slug, and says so", async () => {
    const id = await claimed();
    await renameWorkspace({ flags, out: out(), createCf }, "  Acme   Corp ");

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(await rows()).toEqual([{ id, name: "Acme Corp", slug: "ben-owner" }]);
    expect(events.filter((event) => event["step"] === "workspace.rename")).toEqual([
      expect.objectContaining({ type: "step", status: "start" }),
      expect.objectContaining({
        type: "step",
        status: "ok",
        message: "Renamed Ben Owner to Acme Corp",
        data: { id, name: "Acme Corp", previousName: "Ben Owner", changed: true },
      }),
    ]);
    expect(done()).toMatchObject({
      message: "Renamed the workspace to Acme Corp. Members see the name on their next page.",
      data: {
        organization: { id, name: "Acme Corp", slug: "ben-owner" },
        previousName: "Ben Owner",
        changed: true,
        gateway: "https://example.com",
      },
    });
    expect(done()!["display"]).toBeUndefined();
  });

  it("says when the name is the same already, and writes nothing", async () => {
    const id = await claimed("Acme Corp", "acme-corp");
    account.cf.calls.length = 0;
    await renameWorkspace({ flags, out: out(), createCf }, "Acme Corp");

    expect(await rows()).toEqual([{ id, name: "Acme Corp", slug: "acme-corp" }]);
    expect(done()).toMatchObject({
      message: "The workspace is named Acme Corp already. Nothing changed.",
      data: { previousName: "Acme Corp", changed: false },
    });
    expect(
      account.cf.calls.filter((call) => call.args.join(" ").includes("UPDATE organizations")),
    ).toEqual([]);
  });

  it("refuses a bad name before logging in", async () => {
    await claimed();
    for (const name of ["", "   ", "x".repeat(65), "Acme\nCorp"]) {
      await expect(
        renameWorkspace({ flags, out: out(), createCf }, name),
        JSON.stringify(name),
      ).rejects.toMatchObject({
        code: "WORKSPACE_NAME_INVALID",
        message: expect.stringContaining("Use 1 to 64 characters with no line breaks"),
        fix: "give the name as one argument, quoted when it has spaces",
      });
    }
    expect(createCf).not.toHaveBeenCalled();
    expect((await rows()).map((row) => row["name"])).toEqual(["Ben Owner"]);
  });

  it("refuses a Gateway nobody has claimed: the claim would name the workspace over it", async () => {
    // The install's organization before the claim: no members.
    await db().run([
      {
        sql: "INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-acme', 'Acme', 'acme', 1000)",
      },
    ]);
    await expect(
      renameWorkspace({ flags, out: out(), createCf }, "Acme Corp"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_CLAIMED",
      message: expect.stringContaining("The Gateway has no owner yet"),
    });
    expect((await rows()).map((row) => row["name"])).toEqual(["Acme"]);
  });
});
