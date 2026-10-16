import { describe, expect, it, vi } from "vitest";
import { getAuthTables } from "better-auth/db";

const workerEnv = vi.hoisted(() => ({
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnop",
  DB: {},
  GATEWAY_URL: "https://gateway.example.com",
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

import { auth as cliAuth } from "./cli-config";
import { createAuth } from "./config";

type AnyAuth = { options: Parameters<typeof getAuthTables>[0] };

const pluginIds = (auth: AnyAuth) =>
  (auth.options.plugins ?? []).map((plugin) => plugin.id);

// Drops functions (default values, hooks): only the declared shape matters.
const tables = (auth: AnyAuth) =>
  JSON.parse(JSON.stringify(getAuthTables(auth.options))) as unknown;

/**
 * `auth generate` and `auth:check` (CI) read cli-config.ts, but requests run
 * against config.ts. Better Auth checks the database schema at startup and
 * fails every auth call on a mismatch, so both configs must describe the same
 * schema — a schema-changing plugin or option added to only one of them would
 * pass CI and break sign-in in production.
 */
describe("CLI auth config", () => {
  const runtimeAuth = createAuth() as unknown as AnyAuth;
  const cli = cliAuth as unknown as AnyAuth;

  it("registers the same plugins, in the same order, as the runtime", () => {
    expect(pluginIds(cli)).toEqual(pluginIds(runtimeAuth));
    expect(pluginIds(cli)).toContain("organization");
  });

  it("derives the same database schema as the runtime", () => {
    expect(tables(cli)).toEqual(tables(runtimeAuth));
  });

  // A hosted gateway registers no Cloudflare Access plugin, and runs on the
  // same migrations: the plugins it leaves out add nothing to the schema.
  it("derives the same database schema as a hosted gateway's runtime", () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    try {
      const hosted = createAuth() as unknown as AnyAuth;
      expect(pluginIds(hosted)).not.toContain("cloudflare-access");
      expect(tables(cli)).toEqual(tables(hosted));
    } finally {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    }
  });
});
