import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hyperdriveOriginUrl, parseOriginUrl, readAppSecrets } from "./deploySecrets";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-secrets-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the app's secrets file", () => {
  it("is optional, and kept out of git once there", async () => {
    await expect(readAppSecrets(dir)).resolves.toEqual({});
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);

    fs.mkdirSync(path.join(dir, ".everyapp"));
    fs.writeFileSync(
      path.join(dir, ".everyapp", "secrets.env"),
      "# the app's database\nPOSTGRES_DATABASE_URL=postgres://u:p@h/d\nEMPTY=\n",
    );
    await expect(readAppSecrets(dir)).resolves.toEqual({
      POSTGRES_DATABASE_URL: "postgres://u:p@h/d",
    });
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".everyapp/\n");
  });

  it("gives a Hyperdrive binding its own origin, or the database URL when it is the only one", () => {
    const one = { resources: { hyperdrive: [{ name: "HYPERDRIVE" }] } };
    const two = { resources: { hyperdrive: [{ name: "HYPERDRIVE" }, { name: "REPLICA" }] } };
    const secrets = { POSTGRES_DATABASE_URL: "postgres://a", REPLICA_ORIGIN_URL: "postgres://b" };
    expect(hyperdriveOriginUrl(secrets, one, "HYPERDRIVE")).toEqual({
      url: "postgres://a",
      variable: "POSTGRES_DATABASE_URL",
    });
    expect(hyperdriveOriginUrl(secrets, two, "HYPERDRIVE")).toBeNull();
    expect(hyperdriveOriginUrl(secrets, two, "REPLICA")).toEqual({
      url: "postgres://b",
      variable: "REPLICA_ORIGIN_URL",
    });
  });

  it("parses an origin URL, and names only the variable when it can't", () => {
    expect(parseOriginUrl("postgresql://app%2Brw:p%40ss@db.example.net/seo", "X")).toEqual({
      scheme: "postgresql",
      host: "db.example.net",
      port: 5432,
      database: "seo",
      user: "app+rw",
      password: "p@ss",
    });
    for (const bad of ["not a url", "https://u:p@h/d", "postgres://u@h/d", "postgres://u:p@h/"]) {
      expect(() => parseOriginUrl(bad, "HYPERDRIVE_ORIGIN_URL")).toThrow(
        expect.objectContaining({
          code: "DATABASE_URL_INVALID",
          message: expect.not.stringContaining(bad),
        }),
      );
    }
  });
});
