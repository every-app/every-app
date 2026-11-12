/**
 * The migration to one connection per person per provider
 * (docs/design/2026-11-oauth-one-connection.md), run on the rows a Gateway
 * from before it held: a connection per (organization, provider, person,
 * app). Every migration the journal lists before it is applied, the old
 * rows are written, then it runs.
 */
import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const BEFORE = "0033_app_previous_ids";
const TARGET = "0034_oauth_one_connection";
const journal = JSON.parse(
  fs.readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8"),
) as { entries: { idx: number; tag: string }[] };
const tags = [...journal.entries]
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => entry.tag);

async function apply(client: Client, tag: string): Promise<void> {
  const sql = fs.readFileSync(`${MIGRATIONS_DIR}/${tag}.sql`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.execute(statement);
  }
}

/** A connection as the Gateway before this migration stored one: in an app. */
interface OldConnection {
  id: string;
  organizationId?: string;
  providerId?: string;
  userId: string;
  appRowId: string;
  label?: string | null;
  externalId: string | null;
  scopes: string[];
  status?: "active" | "expired";
  updatedAt: number;
}

async function insertOld(client: Client, row: OldConnection): Promise<void> {
  await client.execute({
    sql: `INSERT INTO provider_connections
            (id, organization_id, provider_id, user_id, app_row_id, label, external_id, scopes, access_token_enc, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.organizationId ?? "org-1",
      row.providerId ?? "google-workspace",
      row.userId,
      row.appRowId,
      row.label ?? null,
      row.externalId,
      JSON.stringify(row.scopes),
      `sealed-${row.id}`,
      row.status ?? "active",
      row.updatedAt - 500,
      row.updatedAt,
    ],
  });
}

async function columns(client: Client, table: string): Promise<string[]> {
  return (await client.execute(`PRAGMA table_info(${table})`)).rows.map((row) =>
    String(row.name),
  );
}

describe(`migration ${TARGET}`, () => {
  let client: Client;

  beforeEach(async () => {
    expect(tags).toContain(BEFORE);
    expect(tags.indexOf(TARGET)).toBe(tags.indexOf(BEFORE) + 1);
    client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = OFF");
    for (const tag of tags.slice(0, tags.indexOf(BEFORE) + 1)) {
      await apply(client, tag);
    }
  });

  const connections = async () =>
    (
      await client.execute(
        `SELECT id, organization_id, provider_id, user_id, external_id, scopes, access_token_enc, status
           FROM provider_connections ORDER BY id`,
      )
    ).rows.map((row) => ({
      id: String(row.id),
      organizationId: String(row.organization_id),
      providerId: String(row.provider_id),
      userId: String(row.user_id),
      externalId: row.external_id === null ? null : String(row.external_id),
      scopes: JSON.parse(String(row.scopes)) as string[],
      accessTokenEnc: String(row.access_token_enc),
      status: String(row.status),
    }));

  /** The access rows, as `organization provider user app: scopes`, sorted. */
  const access = async () =>
    (
      await client.execute(
        `SELECT organization_id, provider_id, user_id, app_row_id, scopes FROM provider_app_access`,
      )
    ).rows
      .map(
        (row) =>
          `${row.organization_id} ${row.provider_id} ${row.user_id} ${row.app_row_id}: ${(JSON.parse(String(row.scopes)) as string[]).join(" ")}`,
      )
      .sort();

  it("keeps one connection per person and provider and turns the others into app access", async () => {
    expect(await columns(client, "provider_connections")).toContain(
      "app_row_id",
    );
    const old: OldConnection[] = [
      // Ben connected the same Google account in mail and seo, with
      // different scopes; mail's holds the most.
      {
        id: "conn_ben_mail",
        userId: "ben",
        appRowId: "app-mail",
        externalId: "g-ben",
        scopes: ["gmail.modify", "openid", "email"],
        updatedAt: 2000,
      },
      {
        id: "conn_ben_seo",
        userId: "ben",
        appRowId: "app-seo",
        externalId: "g-ben",
        scopes: ["webmasters.readonly", "openid"],
        updatedAt: 3000,
      },
      // And another account in notes, the newest of his three.
      {
        id: "conn_ben_notes",
        userId: "ben",
        appRowId: "app-notes",
        externalId: "g-ben-personal",
        scopes: ["drive.readonly"],
        updatedAt: 4000,
      },
      // Pat's connection in mail expired; the one in seo is active, with
      // fewer scopes and older.
      {
        id: "conn_pat_mail",
        userId: "pat",
        appRowId: "app-mail",
        externalId: "g-pat",
        scopes: ["gmail.modify", "openid", "email"],
        status: "expired",
        updatedAt: 5000,
      },
      {
        id: "conn_pat_seo",
        userId: "pat",
        appRowId: "app-seo",
        externalId: "g-pat",
        scopes: ["webmasters.readonly"],
        updatedAt: 1000,
      },
      // Sam's provider gave no id: the label tells the accounts apart.
      {
        id: "conn_sam_mail",
        userId: "sam",
        appRowId: "app-mail",
        externalId: null,
        label: "sam@work.example",
        scopes: ["gmail.modify"],
        updatedAt: 1000,
      },
      {
        id: "conn_sam_seo",
        userId: "sam",
        appRowId: "app-seo",
        externalId: null,
        label: "sam@work.example",
        scopes: ["webmasters.readonly"],
        updatedAt: 2000,
      },
      {
        id: "conn_sam_notes",
        userId: "sam",
        appRowId: "app-notes",
        externalId: null,
        label: "sam@home.example",
        scopes: ["drive.readonly"],
        updatedAt: 500,
      },
      // Another provider and another organization are each their own.
      {
        id: "conn_ben_github",
        userId: "ben",
        appRowId: "app-mail",
        providerId: "github-oauth",
        externalId: "42",
        scopes: ["repo"],
        updatedAt: 1000,
      },
      {
        id: "conn_ben_elsewhere",
        userId: "ben",
        appRowId: "app-other",
        organizationId: "org-2",
        externalId: "g-ben",
        scopes: ["gmail.readonly"],
        updatedAt: 1000,
      },
    ];
    for (const row of old) await insertOld(client, row);
    // A connect in flight when the migration runs.
    await client.execute(
      `INSERT INTO oauth_states (state, provider_id, organization_id, user_id, app_row_id, code_verifier, scopes, return_to, created_at, expires_at)
       VALUES ('state-1', 'google-workspace', 'org-1', 'ben', 'app-mail', 'verifier', '[]', NULL, 1, 2)`,
    );

    await apply(client, TARGET);

    // One row per (organization, provider, person): the active one before
    // an expired one, then the one holding the most scopes, then the newest.
    const kept = await connections();
    expect(kept.map((row) => row.id)).toEqual([
      "conn_ben_elsewhere",
      "conn_ben_github",
      "conn_ben_mail",
      "conn_pat_seo",
      "conn_sam_seo",
    ]);
    const owners = kept.map(
      (row) => `${row.organizationId} ${row.providerId} ${row.userId}`,
    );
    expect(new Set(owners).size).toBe(owners.length);
    // The kept rows are as they were: tokens, scopes, account and status.
    expect(kept.find((row) => row.id === "conn_ben_mail")).toEqual({
      id: "conn_ben_mail",
      organizationId: "org-1",
      providerId: "google-workspace",
      userId: "ben",
      externalId: "g-ben",
      scopes: ["gmail.modify", "openid", "email"],
      accessTokenEnc: "sealed-conn_ben_mail",
      status: "active",
    });
    expect(kept.find((row) => row.id === "conn_pat_seo")).toMatchObject({
      status: "active",
      scopes: ["webmasters.readonly"],
      accessTokenEnc: "sealed-conn_pat_seo",
    });

    // Every app whose connection was to the kept account is allowed, for
    // the scopes its own connection held; an app connected to another
    // account (Ben's and Sam's notes) is not.
    expect(await access()).toEqual([
      "org-1 github-oauth ben app-mail: repo",
      "org-1 google-workspace ben app-mail: gmail.modify openid email",
      "org-1 google-workspace ben app-seo: webmasters.readonly openid",
      "org-1 google-workspace pat app-mail: gmail.modify openid email",
      "org-1 google-workspace pat app-seo: webmasters.readonly",
      "org-1 google-workspace sam app-mail: gmail.modify",
      "org-1 google-workspace sam app-seo: webmasters.readonly",
      "org-2 google-workspace ben app-other: gmail.readonly",
    ]);
    // An access row dates from the connection it was.
    const [seo] = (
      await client.execute(
        `SELECT created_at, updated_at FROM provider_app_access
          WHERE user_id = 'ben' AND app_row_id = 'app-seo'`,
      )
    ).rows;
    expect([Number(seo!.created_at), Number(seo!.updated_at)]).toEqual([
      2500, 3000,
    ]);

    // A person has one connection per provider. `app_row_id` stays for the
    // CLI before this release, which reads it.
    expect(await columns(client, "provider_connections")).toContain(
      "app_row_id",
    );
    await expect(
      client.execute(
        `INSERT INTO provider_connections (id, organization_id, provider_id, user_id, app_row_id, scopes, access_token_enc, status, created_at, updated_at)
         VALUES ('conn_ben_second', 'org-1', 'google-workspace', 'ben', 'app-notes', '[]', 'sealed', 'active', 1, 1)`,
      ),
    ).rejects.toThrow(/UNIQUE/i);

    // A state says who spends it; one in flight is the provider callback's.
    expect(await columns(client, "oauth_states")).toContain("purpose");
    const states = await client.execute(
      "SELECT state, purpose FROM oauth_states",
    );
    expect(states.rows.map((row) => [row.state, row.purpose])).toEqual([
      ["state-1", "authorize"],
    ]);
  });

  it("leaves a Gateway with no connections with the new tables and nothing in them", async () => {
    await apply(client, TARGET);
    expect(await connections()).toEqual([]);
    expect(await access()).toEqual([]);
    expect(await columns(client, "provider_app_access")).toEqual([
      "organization_id",
      "provider_id",
      "user_id",
      "app_row_id",
      "scopes",
      "created_at",
      "updated_at",
    ]);
  });
});
