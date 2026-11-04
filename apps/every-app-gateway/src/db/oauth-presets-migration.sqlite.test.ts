import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
} from "@every-app/sdk/internal";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The migration that registers Google, Microsoft 365 and Slack as rows on a
 * Gateway that already uses them: every migration before it is applied,
 * apps, clients and connections are seeded, then it runs.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TARGET = fs
  .readdirSync(MIGRATIONS_DIR)
  .find((file) => /^\d{4}_oauth_presets_registered\.sql$/.test(file));

function statements(file: string): string[] {
  return fs
    .readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function run(client: Client, file: string) {
  for (const statement of statements(file)) await client.execute(statement);
}

/** The built-in Google's binding key: the preset's endpoints without its revoke URL. */
const BUILT_IN_GOOGLE_KEY = JSON.stringify({
  kind: "oauth2-user",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: null,
  inject: "form",
  clientId: "GOOGLE_WORKSPACE_CLIENT_ID",
  clientSecret: "GOOGLE_WORKSPACE_CLIENT_SECRET",
  hosts: [
    "analyticsadmin.googleapis.com",
    "analyticsdata.googleapis.com",
    "gmail.googleapis.com",
    "openidconnect.googleapis.com",
    "searchconsole.googleapis.com",
    "www.googleapis.com",
  ],
});

describe(`migration ${TARGET}`, () => {
  let client: Client;

  beforeEach(async () => {
    expect(TARGET).toBeDefined();
    client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = OFF");
    const earlier = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file < TARGET!)
      .sort();
    for (const file of earlier) await run(client, file);
  });

  const providerRows = async () =>
    (
      await client.execute(
        "SELECT id, spec, added_by, bound_to FROM providers ORDER BY id",
      )
    ).rows.map((row) => ({
      id: String(row.id),
      spec: String(row.spec),
      addedBy: row.added_by === null ? null : String(row.added_by),
      boundTo: row.bound_to === null ? null : String(row.bound_to),
    }));

  it("registers each preset an installed app lists, or that has a client or a connection, bound to its own endpoints", async () => {
    await client.execute({
      sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, manifest, status)
            VALUES ('app-1', 'org-1', 'openmail', 'OpenMail', '', ?, 'active'),
                   ('app-2', 'org-1', 'gone', 'Gone', '', ?, 'deleted')`,
      args: [
        JSON.stringify({
          capabilities: {
            "google-workspace": { scopes: ["gmail.modify"], why: "Mail." },
          },
        }),
        JSON.stringify({
          capabilities: { slack: { scopes: ["chat:write"], why: "Posts." } },
        }),
      ],
    });
    await client.execute(
      `INSERT INTO oauth_clients (provider_id, client_id, client_secret_enc, bound_to, added_by, added_at, updated_at)
       VALUES ('microsoft-365', 'ms-id', 'v1.sealed', 'x', 'owner@example.com', 1, 1)`,
    );

    await run(client, TARGET!);

    const rows = await providerRows();
    // Slack: only a deleted app listed it, and it has no client or connection.
    expect(rows.map((row) => row.id)).toEqual([
      "google-workspace",
      "microsoft-365",
    ]);
    for (const row of rows) {
      const parsed = parseProviderSpec(JSON.parse(row.spec));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
      expect(parsed.id).toBe(row.id);
      // The SQL's copy is the preset as shipped, so `isPresetRow` holds.
      expect(JSON.parse(row.spec)).toEqual(OAUTH_PRESETS[row.id]);
      expect(row.addedBy).toBe("everyapp");
      expect(row.boundTo).toBe(providerBindingKey(parsed.capability as never));
    }
    // The Gateway serves them, each bound, so a client set from the terminal is read.
    const registry = providerRegistry(rows);
    expect(registry.rejected).toEqual([]);
    expect(registry.bound("google-workspace")).toBe(true);
    expect(JSON.parse(rows[0]!.spec).auth.revokeUrl).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
  });

  it("registers a preset with a connection, and none on a Gateway that uses none", async () => {
    await run(client, TARGET!);
    expect(await providerRows()).toEqual([]);

    await client.execute(
      `INSERT INTO provider_connections (id, organization_id, provider_id, user_id, app_row_id, scopes, access_token_enc, status, created_at, updated_at)
       VALUES ('conn_1', 'org-1', 'slack', 'user-1', 'app-1', '[]', 'v1.sealed', 'active', 1, 1)`,
    );
    await run(client, TARGET!);
    const rows = await providerRows();
    expect(rows.map((row) => row.id)).toEqual(["slack"]);
    expect(JSON.parse(rows[0]!.spec)).toEqual(OAUTH_PRESETS["slack"]);
  });

  it("rebinds a Google client pasted for the built-in to the row, and leaves a row there already alone", async () => {
    await client.execute({
      sql: `INSERT INTO oauth_clients (provider_id, client_id, client_secret_enc, bound_to, added_by, added_at, updated_at)
            VALUES ('google-workspace', 'g-id', 'v1.sealed', ?, 'owner@example.com', 1, 1),
                   ('microsoft-365', 'ms-id', 'v1.sealed', 'other', 'owner@example.com', 1, 1)`,
      args: [BUILT_IN_GOOGLE_KEY],
    });
    await client.execute(
      `INSERT INTO providers (id, spec, added_by, added_at, updated_at) VALUES ('microsoft-365', '{"hand":"written"}', 'x@example.com', 1, 1)`,
    );

    await run(client, TARGET!);

    const rows = await providerRows();
    const google = rows.find((row) => row.id === "google-workspace")!;
    const clients = (
      await client.execute(
        "SELECT provider_id, bound_to FROM oauth_clients ORDER BY provider_id",
      )
    ).rows.map((row) => [row.provider_id, row.bound_to]);
    expect(clients).toEqual([
      ["google-workspace", google.boundTo],
      ["microsoft-365", "other"],
    ]);
    expect(google.boundTo).not.toBe(BUILT_IN_GOOGLE_KEY);
    expect(rows.find((row) => row.id === "microsoft-365")).toMatchObject({
      spec: '{"hand":"written"}',
      boundTo: null,
    });
  });
});
