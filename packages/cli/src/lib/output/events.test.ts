import { describe, expect, it } from "vitest";
import { createHumanSink, createNdjsonSink, type EventSink } from "./events";
import { handTerminalOver } from "./terminal";

const fixedNow = () => new Date("2026-10-12T12:00:00.000Z");

function ndjson() {
  const lines: string[] = [];
  const sink: EventSink = createNdjsonSink(
    (line) => lines.push(line),
    fixedNow,
  );
  const events = () => lines.map((line) => JSON.parse(line) as unknown);
  return { sink, lines, events };
}

describe("createNdjsonSink", () => {
  it("writes one versioned, timestamped JSON object per line", () => {
    const { sink, lines, events } = ndjson();
    sink.emit({ type: "step", step: "auth", status: "start" });
    sink.emit({
      type: "step",
      step: "auth",
      status: "ok",
      data: { email: "a@b.com" },
    });
    sink.emit({
      type: "done",
      data: { gatewayUrl: "https://apps.example.com" },
    });

    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.every((line) => !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(events()).toEqual([
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "step",
        step: "auth",
        status: "start",
      },
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "step",
        step: "auth",
        status: "ok",
        data: { email: "a@b.com" },
      },
      {
        v: 1,
        ts: "2026-10-12T12:00:00.000Z",
        type: "done",
        data: { gatewayUrl: "https://apps.example.com" },
      },
    ]);
    expect(sink.exitCode).toBe(0);
  });

  it("carries what a person must do in action_required and exits 2", () => {
    const { sink, events } = ndjson();
    sink.emit({
      type: "action_required",
      action: "cloudflare_login",
      message: "Log in to Cloudflare to continue.",
      data: { url: "https://dash.cloudflare.com/device", code: "ABCD-1234" },
    });

    expect(events()[0]).toMatchObject({
      type: "action_required",
      action: "cloudflare_login",
      data: { url: "https://dash.cloudflare.com/device", code: "ABCD-1234" },
    });
    expect(sink.exitCode).toBe(2);
  });

  it("exits 1 after an error, whatever came before it", () => {
    const failed = ndjson();
    failed.sink.emit({
      type: "error",
      code: "MIGRATIONS_FAILED",
      message: "boom",
      retryable: false,
    });
    expect(failed.sink.exitCode).toBe(1);

    // An action the run waited for, taken, then a failure further on.
    const waited = ndjson();
    waited.sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Open the link.",
      data: {
        url: "https://apps.example.com/setup#token=est_x",
        waiting: true,
      },
    });
    waited.sink.emit({
      type: "error",
      code: "DNS_RECORD_CONFLICT",
      message: "conflict",
      retryable: false,
    });
    expect(waited.sink.exitCode).toBe(1);

    const blocked = ndjson();
    blocked.sink.emit({
      type: "action_required",
      action: "rerun_interactive",
      message: "Re-run in a terminal.",
    });
    blocked.sink.emit({
      type: "error",
      code: "STRICT_CONFLICT",
      message: "conflict",
      retryable: true,
    });
    expect(blocked.sink.exitCode).toBe(1);
  });

  it("ends 0 once a run that waited for an action is done, and 2 if it stops on one", () => {
    const waited = ndjson();
    waited.sink.emit({
      type: "action_required",
      action: "cloudflare_login",
      message: "Approve the login.",
      data: {
        url: "https://dash.cloudflare.com/oauth2/device",
        code: "ABCD",
        waiting: true,
      },
    });
    expect(waited.sink.exitCode).toBe(2);
    waited.sink.emit({ type: "done" });
    expect(waited.sink.exitCode).toBe(0);

    const stopped = ndjson();
    stopped.sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Open the link.",
      data: { waiting: true },
    });
    stopped.sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Nobody opened it; run setup again.",
    });
    stopped.sink.emit({ type: "done" });
    expect(stopped.sink.exitCode).toBe(2);
  });
});

const RESTORE =
  "CLOUDFLARE_ACCOUNT_ID=acct npx cf@1.0.0-beta.14 d1 time-travel restore db-1 --bookmark b-1 --force";

/** A human sink writing to strings, read back without colors. */
function human(options: Parameters<typeof createHumanSink>[0] = {}) {
  let stdout = "";
  let stderr = "";
  const sink = createHumanSink({
    write: (text) => {
      stdout += text;
    },
    writeProblem: (text) => {
      stderr += text;
    },
    ...options,
  });
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  return {
    sink,
    stdout: () => plain(stdout),
    lines: () => plain(stdout).split("\n").slice(0, -1),
    problems: () => plain(stderr).split("\n").slice(0, -1),
  };
}

/** What `deploy` emits for a first deploy, abridged. */
function firstDeploy(sink: EventSink) {
  sink.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: "Registered todo as every-acme-todo.",
    data: {
      appId: "todo",
      hostname: "todo.apps.example.com",
      existingApp: false,
      defaultAccess: false,
      organizationName: "Example Inc",
    },
  });
  sink.emit({
    type: "progress",
    step: "app.resources",
    message: "Created D1 database every-acme-todo.",
  });
  sink.emit({
    type: "step",
    step: "app.build",
    status: "start",
    message: "Building the app...",
  });
  sink.emit({
    type: "step",
    step: "app.build",
    status: "ok",
    message: "Built the app.",
  });
  sink.emit({
    type: "step",
    step: "app.migrations",
    status: "start",
    message: "Migrating the app's database...",
  });
  sink.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message: `Applied 0000_init.sql, 0001_tags.sql. To roll the database back to before this run: ${RESTORE}`,
    data: {
      applied: ["0000_init.sql", "0001_tags.sql"],
      rollbackCommand: RESTORE,
    },
  });
  sink.emit({
    type: "step",
    step: "app.upload",
    status: "start",
    message: "Uploading every-acme-todo...",
  });
  sink.emit({
    type: "step",
    step: "app.upload",
    status: "ok",
    message: "Uploaded version 3f9c1a2e.",
    data: { versionId: "3f9c1a2e-0000-4000-8000-000000000000" },
  });
  sink.emit({
    type: "step",
    step: "app.bind",
    status: "start",
    message: "Binding APP__EVERY_ACME_TODO on the gateway...",
  });
  sink.emit({
    type: "step",
    step: "gateway.deploy",
    status: "start",
    message: "Deploying gateway 0.4.0 with 1 app...",
  });
  sink.emit({
    type: "step",
    step: "gateway.deploy",
    status: "ok",
    message: "Deployed gateway version 7d20c4e1.",
    data: { versionId: "7d20c4e1-0000-4000-8000-000000000000" },
  });
  sink.emit({
    type: "step",
    step: "app.bind",
    status: "ok",
    message: "Bound.",
  });
  sink.emit({
    type: "step",
    step: "app.live",
    status: "ok",
    message: "todo is live at https://todo.apps.example.com.",
    data: {
      hostname: "todo.apps.example.com",
      url: "https://todo.apps.example.com",
    },
  });
  sink.emit({ type: "done", data: { url: "https://todo.apps.example.com" } });
}

describe("createHumanSink", () => {
  it("shows a first deploy as a few milestone lines, rendered from their data", () => {
    const { sink, lines, problems } = human();
    firstDeploy(sink);

    expect(lines()).toEqual([
      "Deploying todo to Example Inc (first deploy)",
      "Registered todo: private to you, owners and admins (change it in Admin → Apps)",
      "Built ✓",
      "2 migrations applied ✓",
      `  restore point: ${RESTORE}`,
      "Uploaded 3f9c1a2e ✓",
      "Binding to the Gateway",
      "  Uploaded 7d20c4e1 ✓",
      "Live: https://todo.apps.example.com",
    ]);
    expect(problems()).toEqual([]);
    expect(sink.exitCode).toBe(0);
  });

  it("says a new app is private to owners and admins when the login isn't a gateway user", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.register",
      status: "ok",
      data: {
        appId: "todo",
        hostname: "todo.apps.example.com",
        existingApp: false,
        defaultAccess: false,
        deployerAccess: false,
        organizationName: "Example Inc",
      },
    });
    expect(lines()).toEqual([
      "Deploying todo to Example Inc (first deploy)",
      "Registered todo: private to owners and admins (change it in Admin → Apps)",
    ]);
  });

  it("shows a redeploy as a line per step, and one that sends secrets says so on its first line", () => {
    const redeploy = (secrets?: string[]) => {
      const { sink, lines } = human();
      sink.emit({
        type: "step",
        step: "app.register",
        status: "ok",
        data: {
          appId: "todo",
          hostname: "todo.apps.example.com",
          existingApp: true,
          organizationName: "Example Inc",
          ...(secrets ? { secrets } : {}),
        },
      });
      sink.emit({ type: "step", step: "app.build", status: "ok" });
      sink.emit({
        type: "step",
        step: "app.migrations",
        status: "ok",
        data: { applied: [], rollbackCommand: RESTORE },
      });
      sink.emit({
        type: "step",
        step: "app.upload",
        status: "ok",
        data: { versionId: "8a01d4f7-1111" },
      });
      sink.emit({
        type: "step",
        step: "app.live",
        status: "ok",
        data: { url: "https://todo.apps.example.com" },
      });
      sink.emit({ type: "done" });
      return lines();
    };

    expect(redeploy()).toEqual([
      "Deploying todo to Example Inc",
      "Built ✓",
      "Database up to date ✓",
      "Uploaded 8a01d4f7 ✓",
      "Live: https://todo.apps.example.com",
    ]);
    expect(redeploy(["GITHUB_TOKEN"])[0]).toBe(
      "Redeploying todo with GITHUB_TOKEN (code and pending migrations from this directory)",
    );
  });

  it("shows setup's account, the Gateway's upgrade with its steps under it, and what comes next", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "setup.toolchain",
      status: "ok",
      message: "Node 22, cf 1.0.0-beta.14.",
    });
    sink.emit({
      type: "step",
      step: "setup.auth",
      status: "ok",
      message: "Logged in to Cloudflare.",
    });
    sink.emit({
      type: "step",
      step: "setup.account",
      status: "ok",
      data: { id: "acct", name: "Example Inc", email: "ben@example.com" },
    });
    sink.emit({
      type: "progress",
      step: "gateway.release",
      message: "Building the Gateway from this checkout (a minute or two)...",
    });
    sink.emit({
      type: "step",
      step: "setup.gateway",
      status: "start",
      data: {
        release: "0.4.0",
        from: "0.3.0",
        gatewayUrl: "https://apps.example.com",
      },
    });
    sink.emit({
      type: "step",
      step: "gateway.resources",
      status: "ok",
      message: "Ready.",
    });
    sink.emit({
      type: "step",
      step: "gateway.migrations",
      status: "ok",
      data: { applied: ["0031_a.sql", "0032_b.sql"], rollbackCommand: RESTORE },
    });
    sink.emit({
      type: "step",
      step: "gateway.deploy",
      status: "ok",
      data: { versionId: "9c2e1b0d-2222" },
    });
    sink.emit({
      type: "step",
      step: "setup.gateway",
      status: "ok",
      data: { release: "0.4.0" },
    });
    sink.emit({
      type: "step",
      step: "setup.owner",
      status: "ok",
      message: "Owner created: ben@example.com (Example Inc).",
      data: { email: "ben@example.com", organizationName: "Example Inc" },
    });
    sink.emit({
      type: "done",
      message: "Your Gateway is ready: https://apps.example.com",
      data: {
        next: [
          "pnpm everyapp create my-app",
          "AI for apps, any time: pnpm everyapp secret set OPENAI_API_KEY",
        ],
      },
    });

    expect(lines()).toEqual([
      "Cloudflare: ben@example.com · Example Inc",
      "Building the Gateway from this checkout (a minute or two)...",
      "Upgrading the Gateway 0.3.0 → 0.4.0",
      "  2 migrations applied ✓",
      `    restore point: ${RESTORE}`,
      "  Uploaded 9c2e1b0d ✓",
      "Owner created: ben@example.com",
      "Your Gateway is ready: https://apps.example.com",
      "Next: pnpm everyapp create my-app",
      "      AI for apps, any time: pnpm everyapp secret set OPENAI_API_KEY",
    ]);
  });

  it("prints the app.email hint line on a skip", () => {
    const { sink, lines } = human();
    const message =
      "inbox receives no mail yet: `pnpm everyapp email set --inbound <address>` (in its directory) routes addresses to it.";
    sink.emit({ type: "step", step: "app.email", status: "skip", message });
    expect(lines()).toEqual([message]);
  });

  it("says the Gateway is up to date when there is nothing to do", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "setup.gateway",
      status: "skip",
      message: "The gateway already runs release 0.4.0.",
      data: {
        release: "0.4.0",
        gatewayUrl: "https://apps.example.com",
        upToDate: true,
      },
    });
    expect(lines()).toEqual([
      "Gateway 0.4.0 at https://apps.example.com is up to date.",
    ]);
  });

  it("shows progress only with --verbose, except lease and live waits and the Gateway build", () => {
    const emitAll = (sink: EventSink) => {
      sink.emit({
        type: "progress",
        step: "app.resources",
        message: "Created KV namespace every-acme-todo.",
      });
      sink.emit({
        type: "progress",
        step: "app.lease",
        message: "Waiting for another deploy of todo to finish: laptop:42...",
      });
      sink.emit({
        type: "progress",
        step: "app.live",
        message:
          "Waiting for a certificate: todo.apps.example.com (15s so far)...",
      });
      sink.emit({
        type: "step",
        step: "gateway.release",
        status: "ok",
        message: "Using the Gateway 0.4.0 built from this checkout before (3f9c1a2e0b4d).",
      });
    };
    const quiet = human();
    emitAll(quiet.sink);
    expect(quiet.lines()).toEqual([
      "Waiting for another deploy of todo to finish: laptop:42...",
      "Waiting for a certificate: todo.apps.example.com (15s so far)...",
    ]);

    const verbose = human({ verbose: true });
    emitAll(verbose.sink);
    expect(verbose.lines()).toEqual([
      "Created KV namespace every-acme-todo.",
      "Waiting for another deploy of todo to finish: laptop:42...",
      "Waiting for a certificate: todo.apps.example.com (15s so far)...",
      "Using the Gateway 0.4.0 built from this checkout before (3f9c1a2e0b4d).",
    ]);
  });

  it("puts problems on stderr, each ending with the command to run next", () => {
    const { sink, lines, problems } = human();
    sink.emit({
      type: "step",
      step: "app.register",
      status: "ok",
      data: {
        appId: "todo",
        hostname: "todo.apps.example.com",
        existingApp: true,
      },
    });
    sink.emit({
      type: "warning",
      code: "CERT_PENDING",
      message: "No certificate yet.\nIt usually comes within five minutes.",
    });
    sink.emit({
      type: "error",
      code: "DNS_RECORD_CONFLICT",
      message:
        "todo.apps.example.com already has a DNS record (A 203.0.113.7).",
      retryable: false,
      data: { rerun: "pnpm everyapp deploy --force-dns", authorize: true },
    });

    expect(lines()).toEqual(["Deploying todo"]);
    expect(problems()).toEqual([
      "! No certificate yet.",
      "  It usually comes within five minutes.",
      "✗ todo.apps.example.com already has a DNS record (A 203.0.113.7).",
      "  To go ahead anyway: pnpm everyapp deploy --force-dns",
    ]);
    expect(sink.exitCode).toBe(1);
  });

  it("shows an action the run waits for on stdout, and one it stops on with its rerun on stderr", () => {
    const { sink, lines, problems } = human();
    sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Create the owner account with this one-time setup link.",
      data: {
        url: "https://apps.example.com/setup#token=est_x",
        waiting: true,
      },
    });
    sink.emit({
      type: "action_required",
      action: "register_workers_subdomain",
      message: "This Cloudflare account has no workers.dev subdomain yet.",
      data: {
        url: "https://dash.cloudflare.com/acct/workers/onboarding",
        rerun: "pnpm everyapp setup --domain apps.example.com",
      },
    });

    expect(lines()).toEqual([
      "Create the owner account with this one-time setup link.",
      "  https://apps.example.com/setup#token=est_x",
    ]);
    expect(problems()).toEqual([
      "This Cloudflare account has no workers.dev subdomain yet.",
      "  https://dash.cloudflare.com/acct/workers/onboarding",
      "  Then run: pnpm everyapp setup --domain apps.example.com",
    ]);
    expect(sink.exitCode).toBe(2);
  });

  it("draws a spinner at a terminal while a step runs, and makes way for a prompt", () => {
    const { sink, stdout } = human({ terminal: true, columns: () => 120 });
    sink.emit({
      type: "step",
      step: "app.build",
      status: "start",
      message: "Building the app...",
    });
    expect(stdout()).toContain("Building the app... ⠋");

    sink.emit({ type: "step", step: "app.build", status: "ok" });
    sink.emit({
      type: "step",
      step: "app.migrations",
      status: "start",
      message: "Migrating the app's database...",
    });
    expect(stdout()).toContain("Built ✓\n");
    expect(stdout().split("\r\x1b[2K").at(-1)).toBe(
      "Migrating the app's database... ⠋",
    );

    // cf deploy attached to the terminal, or a prompt: the spinner goes first.
    handTerminalOver();
    expect(stdout().split("\r\x1b[2K").at(-1)).toBe("");

    sink.emit({
      type: "step",
      step: "app.migrations",
      status: "ok",
      data: { applied: [] },
    });
    sink.emit({ type: "done" });
    expect(stdout().endsWith("Database up to date ✓\n")).toBe(true);
  });

  it("exits 1 on an error after an action it waited for, like the NDJSON sink", () => {
    const { sink } = human();
    sink.emit({
      type: "action_required",
      action: "cloudflare_login",
      message: "Approve the login.",
      data: { waiting: true },
    });
    sink.emit({ type: "error", code: "X", message: "boom", retryable: false });
    expect(sink.exitCode).toBe(1);
  });
});
