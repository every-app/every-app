import { beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { writeInstall } from "@/lib/gateway/install";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import { mintClaimLink } from "./index";

const DB_ID = "0123456789abcdef0123456789abcdef";

describe("everyapp gateway claim-link", () => {
  let db: SqliteD1;
  let cf: FakeCf;

  beforeEach(async () => {
    db = createSqliteD1();
    cf = new FakeCf()
      .on(["d1", "list"], {
        stdout: JSON.stringify([{ uuid: DB_ID, name: "every-app-gateway" }]),
      })
      .on(["d1"], sqliteD1Script({ [DB_ID]: db }));
    await cf.run({
      plane: "account",
      mode: "json",
      args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
    });
  });

  it("mints a link for an unclaimed gateway at its recorded host", async () => {
    await writeInstall(db, {
      accountId: "acct",
      zoneId: "zone",
      zoneName: "example.com",
      gatewayHost: "example.com",
      appBaseDomain: "example.com",
      routing: "custom-domains",
      oauthKvId: "kv1",
      deployKvId: "kv2",
      releaseVersion: "0.2.0",
      releaseSha256: "a".repeat(64),
      releaseOrder: { schema: 1, builtAt: 0 },
      liveVersionId: null,
      liveDomains: ["example.com"],
      liveAppWorkers: [],
      updatedAt: 0,
      updatedBy: null,
    });

    const link = await mintClaimLink(cf, "ignored.example.net");

    expect(link.url).toMatch(/^https:\/\/example\.com\/setup#token=est_/);
    expect(db.all("SELECT kind FROM owner_setup_tokens")).toEqual([
      { kind: "claim" },
    ]);
  });

  it("refuses once the gateway has an owner", async () => {
    db.sqlite.exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 0);
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'u@x.co', 0, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m', 'org', 'u', 'owner', 0);
    `);

    await expect(mintClaimLink(cf, "example.com")).rejects.toMatchObject({
      code: "GATEWAY_CLAIMED",
    });
    expect(db.all("SELECT kind FROM owner_setup_tokens")).toEqual([]);
  });

  it("explains when no gateway is deployed", async () => {
    cf = new FakeCf().on(["d1", "list"], { stdout: "[]" });
    await expect(mintClaimLink(cf, "example.com")).rejects.toMatchObject({
      code: "GATEWAY_NOT_DEPLOYED",
    });
  });

  it("needs the domain when the gateway predates install records", async () => {
    await expect(mintClaimLink(cf, undefined)).rejects.toMatchObject({
      code: "DOMAIN_REQUIRED",
    });
    await expect(mintClaimLink(cf, "example.com")).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/example\.com\/setup#token=/),
    });
  });
});
