import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  accountFlag,
  gatewayFlag,
  jsonFlag,
  resultJsonFlag,
  verboseFlag,
} from "../flags";

const migrateCommand = buildCommand({
  loader: async () => {
    const { migrate } = await import(".");
    return migrate;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Apply migrations to the local database",
    fullDescription: [
      "Apply the app's migrations to the local database",
      "",
      "Reads migrations from migrations.dir in everyapp.config.ts (default drizzle/).",
      "`everyapp dev` runs this on every start. Production migrations run only during",
      "`everyapp deploy`, after a restore point is saved.",
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
      parameters: [
        { brief: "SQL to run", parse: String, placeholder: "sql", optional: true },
      ],
    },
    flags: {
      local: {
        kind: "boolean",
        brief: "Query the local database `everyapp dev` uses",
        optional: true,
      },
      file: {
        kind: "parsed",
        parse: String,
        brief: "Read the SQL from a file (- for stdin)",
        placeholder: "path",
        optional: true,
      },
      binding: {
        kind: "parsed",
        parse: String,
        brief: "D1 binding to query (default: the migrations binding, or the first)",
        placeholder: "name",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      yes: {
        kind: "boolean",
        brief: "Run SQL that changes the production database without asking",
        optional: true,
      },
      json: { ...resultJsonFlag, brief: "Print rows as NDJSON instead of a table" },
      verbose: { ...verboseFlag, brief: "Show every step" },
    },
  },
  docs: {
    brief: "Run SQL against the production database (or --local)",
    fullDescription: [
      "Run SQL against the app's D1 database",
      "",
      "Runs against the production database unless --local is set; SQL that changes it is",
      "confirmed first (--yes skips that). Rows print as a table; use --json for machine output.",
      "",
      "EXAMPLES",
      '  $ everyapp db query "select * from todos limit 5"',
      '  $ everyapp db query --local "select count(*) from events"',
      "  $ everyapp db query --file scripts/backfill.sql",
    ].join("\n"),
  },
});

const restoreCommand = buildCommand({
  loader: async () => {
    const { restore } = await import("./restore");
    return restore;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "The app (default: the one in this directory)",
          parse: String,
          placeholder: "app",
          optional: true,
        },
      ],
    },
    flags: {
      gateway: {
        kind: "boolean",
        brief: "Restore the Gateway's database, from its last migrating setup or upgrade",
        optional: true,
      },
      "account-id": accountFlag,
      yes: {
        kind: "boolean",
        brief: "Restore without asking",
        optional: true,
      },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Put the production database back to before the last migrations",
    fullDescription: [
      "Put the app's production database back to before its last migrations",
      "",
      "Each deploy that migrates a database with data saves a restore point first (Time Travel).",
      "This restores the last one, after asking: the migrations are undone, and so is anything",
      "written to the database since. --gateway does the same for the Gateway's database.",
      "",
      "EXAMPLES",
      "  $ everyapp db restore",
      "  $ everyapp db restore --gateway",
    ].join("\n"),
  },
});

export const dbRoutes = buildRouteMap({
  routes: {
    migrate: migrateCommand,
    query: queryCommand,
    restore: restoreCommand,
  },
  docs: {
    brief: "Migrate, query and restore an app's D1 database",
  },
});
