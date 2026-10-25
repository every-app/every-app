/**
 * `everyapp workspace rename` and `everyapp workspace role` end to end, in a
 * fake Cloudflare account with a deployed gateway (as provider/index.test.ts):
 * the rows, what each command says, a name refused before any login, a
 * Gateway nobody has claimed, and the one rule, that the workspace always
 * keeps an owner who can act.
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
import { parseWorkspaceRole } from "./command";
import { renameWorkspace, setRole } from "./index";

const GATEWAY = "every-app-gateway";
const ORG = "org-acme";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const gatewayDb = () => [...account.databases.values()].find((entry) => entry.name === GATEWAY)!.db;
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

describe("workspace rename", () => {
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

describe("workspace role", () => {
  function addMember(id: string, role: string): void {
    gatewayDb()
      .sqlite.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
      )
      .run(id, `${id[0]!.toUpperCase()}${id.slice(1)}`, `${id}@example.com`);
    gatewayDb()
      .sqlite.prepare("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 0)")
      .run(`m-${id}`, ORG, id, role);
  }

  /** Deactivated as the Gateway does it: banned, with no expiry (or one still to come). */
  const deactivate = (id: string, banExpires: number | null = null) =>
    gatewayDb().sqlite.prepare("UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?").run(banExpires, id);

  const roleOf = (id: string) =>
    gatewayDb().all("SELECT role FROM members WHERE user_id = ? AND organization_id = ?", id, ORG)[0]?.["role"];

  beforeEach(() => {
    gatewayDb()
      .sqlite.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Acme', 'acme', 0)")
      .run(ORG);
    addMember("ben", "owner");
    addMember("alex", "admin");
    addMember("sam", "member");
    events = [];
  });

  it("makes a member an owner, matching the address without case, and says so", async () => {
    await setRole({ flags, out: out(), createCf }, "Sam@Example.com", "owner");

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(roleOf("sam")).toBe("owner");
    expect(done()).toMatchObject({
      message: "sam@example.com is now an owner of Acme. The Gateway picks up the change within 30 seconds.",
      data: {
        workspace: { id: ORG, name: "Acme" },
        member: { id: "sam", email: "sam@example.com", name: "Sam" },
        role: "owner",
        previousRole: "member",
        changed: true,
      },
    });
  });

  it("lets one of two owners become an admin, and says when nothing changes", async () => {
    await setRole({ flags, out: out(), createCf }, "sam@example.com", "owner");
    events = [];
    await setRole({ flags, out: out(), createCf }, "ben@example.com", "admin");
    expect(roleOf("ben")).toBe("admin");
    expect(roleOf("sam")).toBe("owner");
    expect(done()).toMatchObject({ message: expect.stringContaining("ben@example.com is now an admin of Acme") });

    events = [];
    await setRole({ flags, out: out(), createCf }, "ben@example.com", "admin");
    expect(done()).toMatchObject({
      message: "ben@example.com is already an admin of Acme. Nothing changed.",
      data: { role: "admin", changed: false },
    });
    expect(done()!["data"]["previousRole"]).toBeUndefined();
  });

  it("refuses to demote the last owner, leaving the row as it was", async () => {
    for (const role of ["admin", "member"] as const) {
      await expect(setRole({ flags, out: out(), createCf }, "ben@example.com", role)).rejects.toMatchObject({
        code: "LAST_OWNER",
        message: expect.stringContaining("ben@example.com is the last owner of Acme"),
        rerun: "pnpm everyapp workspace role <email> owner",
        data: { workspace: { id: ORG, name: "Acme" }, member: { id: "ben", email: "ben@example.com" }, role },
      });
    }
    expect(roleOf("ben")).toBe("owner");
  });

  it("counts only owners who can act: a deactivated owner doesn't keep the last live one demotable", async () => {
    await setRole({ flags, out: out(), createCf }, "sam@example.com", "owner");
    deactivate("ben");

    // Sam is the only owner who can sign in: their role stays.
    await expect(setRole({ flags, out: out(), createCf }, "sam@example.com", "admin")).rejects.toMatchObject({
      code: "LAST_OWNER",
      message: expect.stringContaining("sam@example.com is the last owner of Acme"),
    });
    expect(roleOf("sam")).toBe("owner");

    // The deactivated owner can lose the role: Sam remains.
    await setRole({ flags, out: out(), createCf }, "ben@example.com", "member");
    expect(roleOf("ben")).toBe("member");

    // A ban that has run out is no ban: Ben counts again once an owner.
    deactivate("ben", Date.now() - 60_000);
    await setRole({ flags, out: out(), createCf }, "ben@example.com", "owner");
    await setRole({ flags, out: out(), createCf }, "sam@example.com", "admin");
    expect(roleOf("sam")).toBe("admin");
    expect(roleOf("ben")).toBe("owner");

    // A ban still to run out is one: Sam is again the only owner who can act.
    deactivate("ben", Date.now() + 60_000);
    await setRole({ flags, out: out(), createCf }, "sam@example.com", "owner");
    await expect(setRole({ flags, out: out(), createCf }, "sam@example.com", "admin")).rejects.toMatchObject({
      code: "LAST_OWNER",
    });
    expect(roleOf("sam")).toBe("owner");
  });

  it("refuses an address that isn't a member's", async () => {
    await expect(setRole({ flags, out: out(), createCf }, "nobody@example.com", "owner")).rejects.toMatchObject({
      code: "MEMBER_NOT_FOUND",
      message: expect.stringContaining("No member nobody@example.com in Acme"),
      data: { email: "nobody@example.com" },
    });
    expect(gatewayDb().all("SELECT role FROM members WHERE role = 'owner'")).toHaveLength(1);
  });

  it("reads the role as typed, in any case, and refuses anything else", () => {
    expect(parseWorkspaceRole("Owner")).toBe("owner");
    expect(parseWorkspaceRole(" member ")).toBe("member");
    expect(() => parseWorkspaceRole("boss")).toThrow("Use owner, admin or member.");
  });
});
