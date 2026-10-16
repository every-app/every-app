import { describe, expect, it } from "vitest";
import { ManifestError } from "@every-app/perimeter/manifest";
import { CfError, parseCfOutput } from "@/lib/cf/errors";
import {
  ActionRequiredError,
  afterMigration,
  EveryAppError,
} from "@/lib/errors";
import { CLI, thisCommand } from "./command";
import { createNdjsonSink } from "./events";
import { reportFailure } from "./report";

function report(error: unknown) {
  const events: Array<Record<string, any>> = [];
  const out = createNdjsonSink((line) => events.push(JSON.parse(line)));
  reportFailure(out, error);
  return { event: events[0]!, exitCode: out.exitCode };
}

describe("thisCommand", () => {
  it("is the command as given, without --json, to paste into a shell", () => {
    expect(thisCommand([], ["deploy", "--json", "--verbose"])).toBe(
      `${CLI} deploy --verbose`,
    );
    expect(thisCommand(["--force-dns"], ["deploy", "--json"])).toBe(
      `${CLI} deploy --force-dns`,
    );
    expect(thisCommand(["--yes"], ["delete", "todo", "--yes"])).toBe(
      `${CLI} delete todo --yes`,
    );
    expect(
      thisCommand([], ["db", "query", "SELECT * FROM t WHERE a = 'x'"]),
    ).toBe(`${CLI} db query 'SELECT * FROM t WHERE a = '\\''x'\\'''`);
  });
});

describe("reportFailure", () => {
  it("ends an error with the command to run again", () => {
    const { event, exitCode } = report(
      new EveryAppError("SECRET_NAME_TAKEN", "DB is one of todo's bindings."),
    );
    expect(event).toMatchObject({
      type: "error",
      code: "SECRET_NAME_TAKEN",
      data: { rerun: expect.stringMatching(new RegExp(`^${CLI}`)) },
    });
    expect(event["data"]).not.toHaveProperty("authorize");
    expect(exitCode).toBe(1);
  });

  it("says when the rerun takes something over, for an agent to ask first", () => {
    for (const [code, flag] of [
      ["DNS_RECORD_CONFLICT", "--force-dns"],
      ["CONFIRMATION_REQUIRED", "--yes"],
      ["WORKFLOW_REMOVED", "--allow-delete-workflows"],
    ] as const) {
      const { event } = report(new EveryAppError(code, "In the way."));
      expect(event["data"]).toMatchObject({
        rerun: expect.stringMatching(new RegExp(` ${flag}$`)),
        authorize: true,
      });
    }
    // A refused downgrade says which: `git pull`, or setup's flag.
    const { event } = report(
      new EveryAppError("DOWNGRADE_REFUSED", "Behind.", {
        rerun: `${CLI} setup --allow-downgrade`,
        authorize: true,
      }),
    );
    expect(event["data"]).toEqual({ rerun: `${CLI} setup --allow-downgrade`, authorize: true });
  });

  it("carries what else an error says for a script", () => {
    const { event } = report(
      new EveryAppError("GATEWAY_NOT_FOUND", "No Gateway.", {
        rerun: `${CLI} setup`,
        data: { accounts: [{ id: "acct-1", name: "Acme" }] },
      }),
    );
    expect(event["data"]).toEqual({
      accounts: [{ id: "acct-1", name: "Acme" }],
      rerun: `${CLI} setup`,
    });
  });

  it("keeps a rerun the error names", () => {
    const { event } = report(
      new EveryAppError("GATEWAY_OUTDATED", "Upgrade the gateway.", {
        rerun: `${CLI} setup`,
      }),
    );
    expect(event["data"]).toEqual({ rerun: `${CLI} setup` });
  });

  it("repeats the database's restore command in a failure after a migration", () => {
    const restore =
      "npx cf@1.0.0-beta.14 d1 time-travel restore db-1 --bookmark b-1 --force";
    const { event } = report(
      afterMigration(
        new EveryAppError("DEPLOY_NOT_UPLOADED", "cf uploaded nothing."),
        restore,
      ),
    );
    expect(event).toMatchObject({
      message: `cf uploaded nothing.\nTo roll the database back to before this run: ${restore}`,
      data: { rollbackCommand: restore },
    });
    // Not for a failure before any migration.
    expect(
      report(afterMigration(new Error("boom"), null)).event["data"],
    ).not.toHaveProperty("rollbackCommand");
  });

  it("asks for Workers Paid when Cloudflare refuses for the Free plan", () => {
    const refused = new CfError(
      parseCfOutput(
        "┌ Error\n│ This feature needs the Workers Paid plan.\n└\n",
      ),
      { exitCode: 1, stderr: "" },
    );
    const { event, exitCode } = report(refused);
    expect(event).toMatchObject({
      type: "action_required",
      action: "upgrade_workers_paid",
      data: {
        url: expect.stringContaining("/workers/plans"),
        rerun: expect.any(String),
      },
    });
    expect(exitCode).toBe(2);
  });

  it("ends an action with the command to run once it is done", () => {
    const { event } = report(
      new ActionRequiredError(
        "add_domain",
        "Buy a domain.",
        "https://dash.cloudflare.com/acct/domains",
      ),
    );
    expect(event["data"]).toEqual({
      url: "https://dash.cloudflare.com/acct/domains",
      rerun: expect.stringMatching(new RegExp(`^${CLI}`)),
    });
  });

  it("names a broken or missing manifest", () => {
    expect(
      report(new ManifestError("No everyapp.config.ts found.")).event,
    ).toMatchObject({
      code: "INVALID_MANIFEST",
    });
  });
});
