import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import {
  maySetupLinkBeShown,
  mintSetupLink,
  readOwner,
  readSetupLink,
  waitForSetupLink,
} from "./setup-link";

const DB_ID = "0123456789abcdef0123456789abcdef";

let sqlite: SqliteD1;
let cf: FakeCf;

beforeEach(async () => {
  sqlite = createSqliteD1();
  cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }));
  // The gateway's schema, the way a deploy migrates it.
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
  });
  cf.calls.length = 0;
});

const db = () => cfD1Database(cf, DB_ID);
const tokens = () =>
  sqlite.all(
    "SELECT kind, token_hash, expires_at, consumed_at FROM owner_setup_tokens ORDER BY expires_at",
  );

describe("mintSetupLink", () => {
  it("stores only the SHA-256 of a fresh est_ secret, which rides in the fragment", async () => {
    const now = 1_700_000_000_000;
    const link = await mintSetupLink({
      db: db(),
      gatewayUrl: "https://gateway.example.com/",
      now,
    });

    const match = link.url.match(
      /^https:\/\/gateway\.example\.com\/setup#token=(est_[A-Za-z0-9_-]{43})$/,
    );
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(link.expiresAt).toEqual(new Date(now + 24 * 60 * 60 * 1000));
    expect(tokens()).toEqual([
      {
        kind: "claim",
        token_hash: createHash("sha256").update(token).digest("hex"),
        expires_at: now + 24 * 60 * 60 * 1000,
        consumed_at: null,
      },
    ]);
    // One `cf d1 query` with the statements in a private file; the secret
    // itself is neither on argv nor in the file.
    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]!.args).toEqual([
      "d1",
      "query",
      DB_ID,
      "--body",
      "@/fake-cf-files/query.json",
    ]);
    expect(JSON.stringify(cf.calls)).not.toContain(token);
  });

  it("expires the earlier unused link in the same request, and says it did", async () => {
    const first = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 1000 });
    const second = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 2000 });

    expect(first.url).not.toBe(second.url);
    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(tokens().map((row) => row["expires_at"])).toEqual([
      2000,
      2000 + 24 * 60 * 60 * 1000,
    ]);
  });
});

/** The gateway's claim: the owner, their organization and membership, then the link spent. */
function claim(linkId: string, now: number): void {
  sqlite.sqlite.exec(`
    INSERT INTO organizations (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 0);
    INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'owner@x.co', 0, 0, 0);
    INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m', 'org', 'u', 'owner', 0);
    UPDATE owner_setup_tokens SET consumed_at = ${now}, consumed_by = 'u' WHERE id = '${linkId}';
  `);
}

describe("readSetupLink", () => {
  it("is waiting until its own row is spent, then names who it made the owner", async () => {
    const link = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 1000 });
    await expect(readSetupLink(db(), link.id, 2000)).resolves.toEqual({ status: "waiting" });

    claim(link.id, 3000);

    await expect(readSetupLink(db(), link.id, 4000)).resolves.toEqual({
      status: "claimed",
      owner: { email: "owner@x.co", organizationName: "Acme" },
    });
  });

  it("is gone once a newer link replaced it, or it expired", async () => {
    const link = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 1000 });
    await expect(
      readSetupLink(db(), link.id, link.expiresAt.getTime()),
    ).resolves.toEqual({ status: "gone" });

    await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 2000 });
    await expect(readSetupLink(db(), link.id, 3000)).resolves.toEqual({ status: "gone" });
    await expect(readSetupLink(db(), "unknown", 3000)).resolves.toEqual({ status: "gone" });
  });
});

describe("waitForSetupLink", () => {
  it("reads the row every few seconds until the claim, for so long", async () => {
    const link = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x" });
    const slept: number[] = [];
    let now = Date.now();

    const claimed = await waitForSetupLink({
      db: db(),
      id: link.id,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
        if (slept.length === 3) claim(link.id, now);
      },
    });
    expect(claimed).toMatchObject({ status: "claimed" });
    expect(slept).toEqual([5_000, 5_000, 5_000]);

    const other = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x" });
    await expect(
      waitForSetupLink({ db: db(), id: other.id, timeoutMs: 0 }),
    ).resolves.toEqual({ status: "waiting" });
  });
});

describe("readOwner", () => {
  it("reads owner memberships from D1", async () => {
    await expect(readOwner(db())).resolves.toBeNull();

    sqlite.sqlite.exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 0);
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'u@x.co', 0, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m', 'org', 'u', 'owner', 0);
    `);
    await expect(readOwner(db())).resolves.toEqual({ email: "u@x.co", organizationName: "Org" });
  });
});

describe("maySetupLinkBeShown", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows the link to a terminal or an agent on this machine, never into CI", () => {
    vi.stubEnv("CI", "");
    expect(maySetupLinkBeShown({ terminal: true })).toBe(true);
    // `setup --json`: an agent hands the link on to the person it works for.
    expect(maySetupLinkBeShown({ terminal: false, relayed: true })).toBe(true);
    // Piped to a file or a log.
    expect(maySetupLinkBeShown({ terminal: false })).toBe(false);

    vi.stubEnv("CI", "true");
    expect(maySetupLinkBeShown({ terminal: true, relayed: true })).toBe(false);
  });
});
