import { buildCommand, buildRouteMap } from "@stricli/core";
import { accountFlag, gatewayFlag, jsonFlag, resultJsonFlag } from "../flags";

const migrateCommand = buildCommand({
  loader: async () => {
    const { migrate } = await import(".");
    return migrate;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      local: {
        kind: "boolean",
        brief:
          "The local database `everyapp dev` uses: the default, and the only one it migrates",
        optional: true,
      },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Apply the app's migrations to the local database `everyapp dev` uses",
    fullDescription: [
      "Applies the app's D1 migrations (migrations.dir in everyapp.config.ts, default drizzle/)",
      "to the local database in .cloudflare/state that `cf dev` and `everyapp dev` serve:",
      "",
      "  cf d1 migrations apply <local id> --local --persist-to .cloudflare/state --dir <dir>",
      "",
      "`everyapp dev` runs it on every start. Production migrations run inside `everyapp deploy`,",
      "after a restore point, and nowhere else.",
    ].join("\n"),
  },
});

const queryCommand = buildCommand({
  loader: async () => {
    const { query } = await import(".");
    return query;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "SQL to run", parse: String, placeholder: "sql" }],
    },
    flags: {
      local: {
        kind: "boolean",
        brief: "Query the local database `everyapp dev` uses instead",
        optional: true,
      },
      binding: {
        kind: "parsed",
        parse: String,
        brief: "D1 binding (default: the migrations binding, or the first)",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: resultJsonFlag,
    },
  },
  docs: {
    brief: "Run SQL against the app's production D1 database (or --local)",
    fullDescription: [
      "Runs SQL against the app's production D1 database through cf, with your Cloudflare login in the",
      "Gateway's account (or, with --local, against the database in .cloudflare/state).",
      "For anything else, cf works on the database directly: npx cf d1 query <database-id> --sql \"…\"",
    ].join("\n"),
  },
});

export const dbRoutes = buildRouteMap({
  routes: {
    migrate: migrateCommand,
    query: queryCommand,
  },
  docs: {
    brief: "Run migrations and SQL against the app's database",
  },
});
