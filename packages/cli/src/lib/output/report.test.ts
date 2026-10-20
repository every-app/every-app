import { describe, expect, it } from "vitest";
import { ManifestError } from "@every-app/perimeter/manifest";
import { CfError, parseCfOutput } from "@/lib/cf/errors";
import {
  ActionRequiredError,
  afterMigration,
  CancelledError,
  EveryAppError,
} from "@/lib/errors";
import { CLI, invocation, thisCommand, thisCommandWithout } from "./command";
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

describe("invocation", () => {
  it("is how the person ran everyapp: through their package manager, or directly", () => {
    expect(invocation({ npm_config_user_agent: "pnpm/10.34.5 npm/? node/v24.22.0 darwin arm64" })).toBe(
      "pnpm everyapp",
    );
    expect(invocation({ npm_config_user_agent: "npm/10.9.2 node/v22.18.0 darwin arm64" })).toBe("npx everyapp");
    expect(invocation({})).toBe("everyapp");
  });
});

describe("thisCommandWithout", () => {
  it("drops a flag and its value, however it was given", () => {
    expect(thisCommandWithout("--gateway", ["secret", "list", "--gateway", "https://a.dev"])).toBe(
      `${CLI} secret list`,
    );
    expect(thisCommandWithout("--gateway", ["secret", "list", "--gateway=https://a.dev", "--json"])).toBe(
      `${CLI} secret list`,
    );
  });
});

describe("reportFailure", () => {
  it("never suggests the failing command again where that can't help", () => {
    const { event, exitCode } = report(
      new EveryAppError("SECRET_NAME_TAKEN", "DB is one of todo's bindings", {
        fix: "pick another name",
      }),
    );
    expect(event).toMatchObject({
      type: "error",
      code: "SECRET_NAME_TAKEN",
      data: { fix: "pick another name" },
    });
    expect(event["data"]).not.toHaveProperty("rerun");
    expect(event["data"]).not.toHaveProperty("authorize");
    expect(exitCode).toBe(1);
  });

  it("ends a retryable error with the command to run again, and its note", () => {
    const { event } = report(
      new EveryAppError("LEASE_HELD", "Another deploy is running", {
        retryable: true,
        rerunNote: "once it's done",
      }),
    );
    expect(event).toMatchObject({
      retryable: true,
      data: { rerun: expect.stringMatching(new RegExp(`^${CLI}`)), rerunNote: "once it's done" },
    });
  });

  it("calls an error everyapp didn't raise a bug, with its stack, and suggests --verbose", () => {
    const { event } = report(new TypeError("Cannot read properties of undefined (reading 'workerName')"));
    expect(event).toMatchObject({
      code: "UNEXPECTED",
      message:
        "everyapp hit an unexpected error\nTypeError: Cannot read properties of undefined (reading 'workerName')\nThis is a bug in everyapp, not something you did.",
      data: {
        stack: expect.stringContaining("TypeError"),
        rerun: expect.stringMatching(/ --verbose$/),
        rerunNote: "for a stack trace to report",
      },
    });
  });

  it("reports a network failure as one to retry, not a bug", () => {
    const failed = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }),
    });
    expect(report(failed).event).toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      data: { rerun: expect.stringMatching(new RegExp(`^${CLI}`)) },
    });
  });

  it("reports a declined prompt as a cancel", () => {
    expect(report(new CancelledError("Cancelled. Nothing deleted.")).event).toEqual({
      v: 1,
      ts: expect.any(String),
      type: "error",
      code: "CANCELLED",
      message: "Cancelled. Nothing deleted.",
      retryable: false,
      data: {},
    });
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

  it("says how to restore the database in a failure after a migration", () => {
    const rollbackCommand =
      "npx cf@1.0.0-beta.14 d1 time-travel restore db-1 --bookmark b-1 --force";
    const { event } = report(
      afterMigration(
        new EveryAppError("DEPLOY_NOT_UPLOADED", "cf uploaded nothing."),
        { restoreCommand: `${CLI} db restore`, rollbackCommand },
      ),
    );
    // People get everyapp's short command; scripts cf's own.
    expect(event).toMatchObject({
      message: `cf uploaded nothing.\nThe database stays migrated. To roll it back: ${CLI} db restore`,
      data: { rollbackCommand },
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

  it("names a broken manifest", () => {
    expect(
      report(new ManifestError("resources.d1 must be an array.")).event,
    ).toMatchObject({
      code: "INVALID_MANIFEST",
    });
  });
});
