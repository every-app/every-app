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
  gatewayHasOwner,
  mintSetupLink,
  setupLinkForDeploy,
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

  it("expires the earlier unused link in the same request", async () => {
    const first = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 1000 });
    const second = await mintSetupLink({ db: db(), gatewayUrl: "https://g.x", now: 2000 });

    expect(first.url).not.toBe(second.url);
    expect(tokens().map((row) => row["expires_at"])).toEqual([
      2000,
      2000 + 24 * 60 * 60 * 1000,
    ]);
  });
});

describe("gatewayHasOwner", () => {
  it("reads owner memberships from D1", async () => {
    await expect(gatewayHasOwner(db())).resolves.toBe(false);

    sqlite.sqlite.exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 0);
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'u@x.co', 0, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m', 'org', 'u', 'owner', 0);
    `);
    await expect(gatewayHasOwner(db())).resolves.toBe(true);
  });
});

describe("setupLinkForDeploy", () => {
  const isTTY = process.stdout.isTTY;
  const deploy = (printSetupLink?: boolean, onUnattended = vi.fn()) =>
    setupLinkForDeploy({
      db: db(),
      gatewayUrl: "https://gateway.example.com",
      printSetupLink,
      onUnattended,
    });

  function runIn(terminal: boolean, ci: boolean) {
    Object.defineProperty(process.stdout, "isTTY", {
      value: terminal,
      configurable: true,
    });
    vi.stubEnv("CI", ci ? "true" : "");
  }

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: isTTY,
      configurable: true,
    });
    vi.unstubAllEnvs();
  });

  it("mints the link for someone at a terminal", async () => {
    runIn(true, false);

    const link = await deploy();
    expect(link?.url).toMatch(/\/setup#token=est_/);
    expect(tokens()).toHaveLength(1);
  });

  it("never mints a link into CI or piped logs, only says how to get one", async () => {
    for (const [terminal, ci] of [
      [true, true],
      [false, false],
    ] as const) {
      runIn(terminal, ci);
      const onUnattended = vi.fn();

      await expect(deploy(false, onUnattended)).resolves.toBeNull();
      expect(onUnattended).toHaveBeenCalledOnce();
    }
    // Nothing minted, so a link the deployer already has keeps working.
    expect(tokens()).toEqual([]);
  });

  it("prints the link in CI when asked to", async () => {
    runIn(false, true);

    await expect(deploy(true)).resolves.toMatchObject({
      url: expect.stringContaining("/setup#token=est_"),
    });
  });
});
