/**
 * The recovery link (`workspace reset-link`) against the Gateway's schema
 * on SQLite, through `cf d1 query` as the command sends it: Better Auth's
 * own reset row for an active member of the install organization alone.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createSqliteD1, GATEWAY_MIGRATIONS_DIR, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import { mintInvitationLink, mintRecoveryLink } from "./recovery";

const DB_ID = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-11-02T09:00:00Z");
const GATEWAY = "https://apps.example.com";

let sqlite: SqliteD1;
let cf: FakeCf;

beforeEach(async () => {
  sqlite = createSqliteD1();
  cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }));
  await cf.run({ plane: "account", mode: "json", args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR] });
  const run = (sql: string, ...params: Array<string | number>) => sqlite.sqlite.prepare(sql).run(...params);
  run("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 0), ('org-2', 'Beta', 'beta', 1)");
  for (const [id, email, banned] of [
    ["u-owner", "owner@example.com", 0],
    ["u-gone", "gone@example.com", 1],
    ["u-both", "both@example.com", 0],
  ] as const) {
    run("INSERT INTO users (id, name, email, email_verified, banned) VALUES (?, ?, ?, 1, ?)", id, id, email, banned);
  }
  run("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org-1', 'u-owner', 'owner', 0), ('m2', 'org-1', 'u-gone', 'member', 0), ('m3', 'org-1', 'u-both', 'member', 0), ('m4', 'org-2', 'u-both', 'owner', 0)");
});

const db = () => cfD1Database(cf, DB_ID);

describe("mintRecoveryLink", () => {
  it("writes Better Auth's reset row for an owner of the install organization and prints its link", async () => {
    const link = await mintRecoveryLink(db(), GATEWAY, "Owner@Example.com", NOW);
    expect(link).toMatchObject({ member: { id: "u-owner", email: "owner@example.com" }, organization: { id: "org-1" }, expiresAt: NOW + 3_600_000 });
    const token = new URL(link.url).searchParams.get("token")!;
    expect(link.url.startsWith(`${GATEWAY}/reset-password?token=`)).toBe(true);
    expect(sqlite.all("SELECT identifier, value FROM verifications")).toEqual([{ identifier: `reset-password:${token}`, value: "u-owner" }]);
  });

  it("refuses a deactivated member, one in another organization too, and someone who isn't a member", async () => {
    await expect(mintRecoveryLink(db(), GATEWAY, "gone@example.com", NOW)).rejects.toMatchObject({ code: "PASSWORD_RESET_REQUIRES_ACTIVE_USER" });
    await expect(mintRecoveryLink(db(), GATEWAY, "both@example.com", NOW)).rejects.toMatchObject({ code: "USER_IN_OTHER_ORGANIZATION" });
    await expect(mintRecoveryLink(db(), GATEWAY, "nobody@example.com", NOW)).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(sqlite.all("SELECT * FROM verifications")).toEqual([]);
  });
});

describe("mintInvitationLink", () => {
  beforeEach(() => {
    const invite = (id: string, org: string, email: string, status: string, expiresAt: number) =>
      sqlite.sqlite
        .prepare("INSERT INTO invitations (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES (?, ?, ?, 'member', ?, ?, 0, 'u-owner')")
        .run(id, org, email, status, expiresAt);
    invite("inv-ann", "org-1", "ann@example.com", "pending", NOW + 3_600_000);
    invite("inv-old", "org-1", "old@example.com", "pending", NOW - 1);
    invite("inv-done", "org-1", "done@example.com", "accepted", NOW + 3_600_000);
    invite("inv-beta", "org-2", "bea@example.com", "pending", NOW + 3_600_000);
  });

  it("stores the SHA-256 of a new einv_ token for a pending invitation, by email or id, and prints its link", async () => {
    const link = await mintInvitationLink(db(), GATEWAY, "Ann@Example.com", NOW);
    expect(link).toMatchObject({ invitation: { id: "inv-ann", email: "ann@example.com" }, organization: { id: "org-1" }, expiresAt: NOW + 3_600_000 });
    expect(link.url.startsWith(`${GATEWAY}/accept-invitation?token=einv_`)).toBe(true);
    const token = new URL(link.url).searchParams.get("token")!;
    expect(sqlite.all("SELECT invitation_id, token_hash FROM invitation_link_tokens")).toEqual([
      { invitation_id: "inv-ann", token_hash: createHash("sha256").update(token).digest("hex") },
    ]);
    await mintInvitationLink(db(), GATEWAY, "inv-ann", NOW);
    expect(sqlite.all("SELECT invitation_id FROM invitation_link_tokens")).toHaveLength(2);
  });

  it("refuses an expired, accepted or unknown invitation, and one of another organization", async () => {
    for (const who of ["old@example.com", "done@example.com", "nobody@example.com", "bea@example.com", "inv-beta"]) {
      await expect(mintInvitationLink(db(), GATEWAY, who, NOW)).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
    }
    expect(sqlite.all("SELECT * FROM invitation_link_tokens")).toEqual([]);
  });
});
