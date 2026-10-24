import { describe, expect, it, vi } from "vitest";
import { handleInterrupt, onInterrupt } from "@/lib/interrupt";
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
        data: { gatewayUrl: "https://apps.example.com", durationMs: 0 },
      },
    ]);
    expect(sink.exitCode).toBe(0);
  });

  it("says a warning raised again with the same words once, and how long the run took", () => {
    const { sink, events } = ndjson();
    const unchecked = {
      type: "warning",
      code: "CUSTOM_DOMAIN_OWNER_UNCHECKED",
      message: "If another Worker already serves todo.example.com, it will be replaced by this deployment.",
    } as const;
    sink.emit({ ...unchecked, step: "app.domain" });
    sink.emit({ ...unchecked, step: "gateway.domains" });
    sink.emit({ type: "warning", code: "CUSTOM_DOMAIN_OWNER_UNCHECKED", message: "Another host." });
    sink.emit({ type: "done" });
    expect(events()).toEqual([
      expect.objectContaining({ step: "app.domain" }),
      expect.objectContaining({ message: "Another host." }),
      expect.objectContaining({ type: "done", data: { durationMs: 0 } }),
    ]);
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
    step: "app.deploy",
    status: "ok",
    data: { appId: "todo", gatewayHost: "apps.example.com", organizationName: "Example Inc", firstDeploy: true },
  });
  sink.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: "Registered todo as every-acme-todo.",
    data: {
      appId: "todo",
      hostname: "todo.apps.example.com",
      existingApp: false,
      firstDeploy: true,
      defaultAccess: false,
      hasOwner: true,
      organizationName: "Example Inc",
      gatewayUrl: "https://apps.example.com",
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
    message: `Applied 0000_init.sql, 0001_tags.sql. Restore point saved; to undo: pnpm everyapp db restore`,
    data: {
      applied: ["0000_init.sql", "0001_tags.sql"],
      restoreCommand: "pnpm everyapp db restore",
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
      "Deploying todo to apps.example.com (Example Inc)",
      "Built ✓",
      "Database migrated ✓ 0000_init.sql, 0001_tags.sql",
      "  Restore point saved. To undo: pnpm everyapp db restore",
      "Uploaded ✓",
      "Added to the Gateway ✓",
      "",
      "Live    https://todo.apps.example.com",
      "Access  Private to you, owners and admins · change it at https://apps.example.com/admin/apps",
    ]);
    expect(problems()).toEqual([]);
    expect(sink.exitCode).toBe(0);
  });

  it("says a new app is private to owners and admins when the login isn't a gateway user, and who gets it before the Gateway has an owner", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.register",
      status: "ok",
      data: {
        appId: "todo",
        hostname: "todo.apps.example.com",
        existingApp: false,
        firstDeploy: true,
        defaultAccess: false,
        deployerAccess: false,
        hasOwner: false,
        organizationName: "Example Inc",
        gatewayUrl: "https://apps.example.com",
      },
    });
    sink.emit({ type: "done" });
    expect(lines()).toEqual([
      "",
      "Access  Private to owners and admins · change it at https://apps.example.com/admin/apps",
      "  The Gateway has no owner yet; its first owner gets the app (pnpm everyapp setup).",
    ]);
  });

  it("says what a redeploy's manifest opens to the internet, after where the app is", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.register",
      status: "ok",
      data: {
        appId: "hooks",
        hostname: "hooks.apps.example.com",
        existingApp: true,
        firstDeploy: false,
        organizationName: "Example Inc",
        publicRoutes: [
          { path: "/hooks/*", methods: ["GET"] },
          { path: "/uploads/**", methods: ["GET", "HEAD"] },
        ],
      },
    });
    sink.emit({
      type: "step",
      step: "app.live",
      status: "ok",
      data: { hostname: "hooks.apps.example.com", url: "https://hooks.apps.example.com" },
    });
    sink.emit({ type: "done", data: { url: "https://hooks.apps.example.com" } });
    expect(lines()).toEqual([
      "",
      "Live    https://hooks.apps.example.com",
      "Public  Open to the internet without sign-in: GET /hooks/*, GET/HEAD /uploads/**",
    ]);
  });

  it("heads a release's deploy with its version and origin", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.deploy",
      status: "ok",
      data: {
        appId: "analytics",
        gatewayHost: "apps.example.com",
        organizationName: "Example Inc",
        firstDeploy: false,
        version: "1.4.2",
        origin: "github.com/acme/analytics (release v1.4.2)",
      },
    });
    sink.emit({ type: "step", step: "app.build", status: "ok", data: { release: true } });
    expect(lines()).toEqual([
      "Deploying analytics 1.4.2 to apps.example.com (Example Inc)",
      "  From github.com/acme/analytics (release v1.4.2)",
      "Release checked ✓",
    ]);
  });

  it("shows a redeploy as a line per step", () => {
    const redeploy = () => {
      const { sink, lines } = human();
      sink.emit({
        type: "step",
        step: "app.deploy",
        status: "ok",
        data: { appId: "todo", gatewayHost: "apps.example.com", organizationName: "Example Inc", firstDeploy: false },
      });
      sink.emit({
        type: "step",
        step: "app.register",
        status: "ok",
        data: {
          appId: "todo",
          hostname: "todo.apps.example.com",
          existingApp: true,
          firstDeploy: false,
          organizationName: "Example Inc",
        },
      });
      sink.emit({ type: "step", step: "app.build", status: "ok" });
      sink.emit({
        type: "step",
        step: "app.migrations",
        status: "ok",
        data: { applied: [] },
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
      "Deploying todo to apps.example.com (Example Inc)",
      "Built ✓",
      "Database up to date ✓",
      "Uploaded ✓",
      "",
      "Live  https://todo.apps.example.com",
    ]);
  });

  it("leaves the Gateway settings line to access on's own summary, and says it on its own otherwise", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "access.update", status: "start", message: "Checking Cloudflare Access..." });
    sink.emit({ type: "step", step: "secrets.gateway", status: "start", message: "Updating the Gateway..." });
    sink.emit({ type: "step", step: "secrets.gateway", status: "ok", message: "Set CLOUDFLARE_ACCESS_AUD on the Gateway" });
    sink.emit({ type: "step", step: "access.update", status: "ok" });
    sink.emit({ type: "done", message: "Gateway settings set.", display: "Gateway settings ✓ CLOUDFLARE_ACCESS_AUD" });
    expect(lines()).toEqual(["Gateway settings ✓ CLOUDFLARE_ACCESS_AUD"]);

    const alone = human();
    alone.sink.emit({ type: "step", step: "secrets.gateway", status: "start", message: "Updating the Gateway..." });
    alone.sink.emit({ type: "step", step: "secrets.gateway", status: "ok", message: "Set CLOUDFLARE_ACCESS_AUD on the Gateway" });
    alone.sink.emit({ type: "done", message: "Set CLOUDFLARE_ACCESS_AUD on the Gateway.", display: "" });
    expect(alone.lines()).toEqual(["Set CLOUDFLARE_ACCESS_AUD on the Gateway ✓"]);
  });

  it("shows setup's install a step a line, with each slow step's time, then the facts, the run's time and what comes next", () => {
    let now = 0;
    const { sink, lines } = human({ now: () => now });
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
      type: "step",
      step: "setup.gateway",
      status: "start",
      data: {
        change: "install",
        release: "0.4.0",
        releaseName: "0.4.0",
        from: null,
        gatewayUrl: "https://apps.example.com",
        expectedMinutes: { min: 5, max: 10 },
      },
    });
    sink.emit({ type: "step", step: "gateway.migrations", status: "start" });
    now += 400;
    sink.emit({
      type: "step",
      step: "gateway.migrations",
      status: "ok",
      data: { applied: ["0000_a.sql", "0001_b.sql"], fresh: true },
    });
    sink.emit({ type: "step", step: "gateway.deploy", status: "start" });
    now += 6_100;
    sink.emit({
      type: "step",
      step: "gateway.deploy",
      status: "ok",
      data: { versionId: "9c2e1b0d-2222" },
    });
    sink.emit({ type: "step", step: "setup.gateway", status: "ok", data: { release: "0.4.0" } });
    now += 30_000;
    sink.emit({
      type: "step",
      step: "setup.owner",
      status: "ok",
      data: { email: "ben@example.com", organizationName: "Example Inc" },
    });
    sink.emit({
      type: "done",
      data: {
        facts: [
          { label: "Gateway", value: "https://apps.example.com" },
          { label: "Admin", value: "https://apps.example.com/admin", note: "invite people" },
        ],
        // What setup says next (commands/setup/index.ts).
        next: [
          { command: "pnpm everyapp create my-app", note: "start your first app" },
          {
            command: "pnpm everyapp access on",
            note: "put Cloudflare Access in front of your Gateway (recommended)",
          },
          {
            command: "pnpm everyapp secret set OPENAI_API_KEY",
            note: "AI for apps (or OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN)",
          },
          {
            command: "pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME",
            note: "email invites and password resets; needs Cloudflare Email Sending",
          },
        ],
      },
    });

    expect(lines()).toEqual([
      "Setting up Every App in Example Inc (ben@example.com)",
      // How long until the owner link, from the step's `data.expectedMinutes`.
      "Installing the Gateway at apps.example.com (0.4.0) (usually 5–10 minutes, then the owner link)",
      "Database created ✓ 2 migrations",
      "Uploaded ✓ 6.1s",
      "Owner account created for ben@example.com ✓",
      "",
      "Gateway  https://apps.example.com",
      "Admin    https://apps.example.com/admin  invite people",
      "Done in 37s",
      "",
      "Next:",
      "  pnpm everyapp create my-app                          start your first app",
      "  pnpm everyapp access on                              put Cloudflare Access in front of your Gateway (recommended)",
      "  pnpm everyapp secret set OPENAI_API_KEY              AI for apps (or OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN)",
      "  pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME  email invites and password resets; needs Cloudflare Email Sending",
    ]);
  });

  it("shows db migrate's files under its ticked line, and db restore what it undid", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "db.migrate", status: "start" });
    sink.emit({
      type: "step",
      step: "db.migrate",
      status: "ok",
      data: { applied: ["0000_dry_bloodaxe.sql", "0001_add_events.sql"] },
    });
    sink.emit({ type: "step", step: "db.restore", status: "start" });
    sink.emit({
      type: "step",
      step: "db.restore",
      status: "ok",
      data: { appId: null, migrations: ["0007_x.sql"] },
    });

    expect(lines()).toEqual([
      "2 migrations applied to the local database ✓",
      "  0000_dry_bloodaxe.sql",
      "  0001_add_events.sql",
      "Restored the Gateway's database ✓ before 0007_x.sql",
    ]);
  });

  it("ticks Email Routing turned on, then the routed mail with how to reply from it", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.email",
      status: "skip",
      message: "inbox receives no mail yet.",
    });
    sink.emit({
      type: "step",
      step: "app.email",
      status: "ok",
      data: {
        addresses: ["support@example.com"],
        enabled: ["example.com"],
        replyHint: "To reply from example.com, set up Email Sending, then: pnpm everyapp email set --sender",
      },
    });
    expect(lines()).toEqual([
      "Email Routing turned on for example.com ✓",
      "Mail to support@example.com routed ✓",
      "  To reply from example.com, set up Email Sending, then: pnpm everyapp email set --sender",
    ]);
  });

  it("indents an upgrade of the Gateway under its heading while an app is added", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "app.bind", status: "start", data: { appId: "todo" } });
    sink.emit({
      type: "step",
      step: "gateway.upgrade",
      status: "start",
      data: { from: "0.2.0", to: "0.2.1" },
    });
    sink.emit({ type: "step", step: "gateway.release", status: "ok", data: { cached: false } });
    sink.emit({ type: "step", step: "gateway.migrations", status: "start" });
    sink.emit({
      type: "step",
      step: "gateway.migrations",
      status: "ok",
      data: { applied: ["0007_x.sql"], restoreCommand: "pnpm everyapp db restore --gateway" },
    });
    sink.emit({ type: "step", step: "gateway.deploy", status: "start" });
    sink.emit({ type: "step", step: "gateway.deploy", status: "ok" });
    sink.emit({ type: "step", step: "gateway.upgrade", status: "ok" });
    sink.emit({ type: "step", step: "app.bind", status: "ok" });
    expect(lines()).toEqual([
      "Gateway 0.2.0 → 0.2.1",
      "  Built ✓",
      "  Database migrated ✓ 0007_x.sql",
      "    Restore point saved. To undo: pnpm everyapp db restore --gateway",
      "  Uploaded ✓",
      "Added to the Gateway ✓",
    ]);
  });

  it("ends a deploy that isn't live yet with its URL and when it goes live, or that nothing routes to it", () => {
    const end = (data: Record<string, unknown>) => {
      const { sink, lines } = human();
      sink.emit({ type: "step", step: "app.live", status: "skip", data });
      sink.emit({ type: "done" });
      return lines();
    };
    expect(end({ url: "https://todo.example.com", reason: "certificate" })).toEqual([
      "",
      "URL     https://todo.example.com",
      "Status  Goes live on its first visit, once its certificate comes (a few minutes)",
    ]);
    expect(end({ url: "https://todo.example.com", reason: "outside-base" })).toEqual([
      "",
      "Live  Not routed",
    ]);
  });

  it("shows release's tarball, its SHA-256 and how to install it", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "app.release",
      status: "ok",
      data: { appId: "analytics", version: "1.4.2", shown: "./everyapp-release.tar.gz", sha256: "9f3c1a2e4b5d6e7f" },
    });
    sink.emit({
      type: "done",
      data: { next: [{ command: "pnpm everyapp install ./everyapp-release.tar.gz", note: "installs it" }] },
    });
    expect(lines()).toEqual([
      "Packed analytics 1.4.2 ✓",
      "",
      "Release  ./everyapp-release.tar.gz",
      "SHA-256  9f3c1a2e4b5d",
      "",
      "Next:",
      "  pnpm everyapp install ./everyapp-release.tar.gz  installs it",
    ]);
  });

  it("shows a dev run: its steps ticked, the ready block, tool calls as they come, then the stop", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "dev.types", status: "start", message: "Generating Worker types..." });
    sink.emit({ type: "step", step: "dev.types", status: "ok", message: "Generated the Worker's types (.cloudflare/types)." });
    sink.emit({ type: "step", step: "dev.migrations", status: "start", message: "Applying local migrations..." });
    sink.emit({
      type: "step",
      step: "dev.migrations",
      status: "ok",
      data: { applied: ["0000_init.sql", "0001_tags.sql"] },
    });
    sink.emit({ type: "step", step: "dev.app", status: "start", message: "Starting todo..." });
    sink.emit({
      type: "step",
      step: "dev.app",
      status: "ok",
      message: "\n  App  http://todo.localhost:8787\n",
      data: { appId: "todo" },
    });
    sink.emit({ type: "step", step: "dev.ready", status: "ok", data: { port: 8787 } });
    sink.emit({ type: "progress", step: "dev.session", message: "Every request goes through the real perimeter. Ctrl+C to stop." });
    sink.emit({ type: "progress", step: "dev.mcp", message: "MCP  list_todos  ok  12ms" });
    sink.emit({ type: "step", step: "dev.stop", status: "ok", data: { appId: "todo", started: true } });

    expect(lines()).toEqual([
      "Worker types generated ✓ .cloudflare/types",
      "2 local migrations applied ✓",
      "todo is running locally ✓",
      "",
      "  App  http://todo.localhost:8787",
      "",
      "Every request goes through the real perimeter. Ctrl+C to stop.",
      "MCP  list_todos  ok  12ms",
      "todo stopped ✓",
    ]);
  });

  it("says when dev skipped its migrations or stopped before the app started", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "dev.migrations", status: "skip", data: { reason: "no_d1" } });
    sink.emit({ type: "step", step: "dev.migrations", status: "skip", data: { reason: "flag" } });
    sink.emit({ type: "step", step: "dev.migrations", status: "ok", data: { applied: [] } });
    sink.emit({ type: "step", step: "dev.stop", status: "ok", data: { appId: "todo", started: false } });
    expect(lines()).toEqual([
      "Skipped local migrations (--skip-migrations)",
      "Local database up to date ✓",
      "Stopped before todo started.",
    ]);
  });

  it("says the Gateway is up to date when there is nothing to do, and who owns it", () => {
    const { sink, lines } = human();
    sink.emit({
      type: "step",
      step: "setup.account",
      status: "ok",
      data: { id: "acct", name: "Ben Senescu", email: "ben@example.com", gateway: true },
    });
    sink.emit({
      type: "step",
      step: "setup.gateway",
      status: "skip",
      message: "The Gateway is up to date with 0.4.0",
      data: {
        release: "0.4.0",
        releaseName: "0.4.0",
        gatewayUrl: "https://apps.example.com",
        upToDate: true,
        account: "Ben Senescu",
      },
    });
    sink.emit({
      type: "step",
      step: "setup.owner",
      status: "skip",
      data: { email: "ben@example.com", organizationName: "Ben Senescu" },
    });
    expect(lines()).toEqual([
      "Ben Senescu's Gateway is up to date with 0.4.0 ✓",
      "Owner account is ben@example.com ✓",
    ]);
  });

  it("names what setup does to a live Gateway, and the apps a repair routes", () => {
    const { sink, lines } = human();
    const start = (data: Record<string, unknown>) =>
      sink.emit({
        type: "step",
        step: "setup.gateway",
        status: "start",
        data: { gatewayUrl: "https://apps.example.com", account: "Ben Senescu", ...data },
      });
    start({ change: "upgrade", from: "0.3.0", release: "0.4.0", releaseName: "0.4.0" });
    start({ change: "upgrade", from: "0.4.0", release: "0.4.0", releaseName: "commit 981c72da" });
    // An install that doesn't say how long it takes gets no estimate.
    start({ change: "install", from: null, release: "0.4.0", releaseName: "0.4.0" });
    start({ change: "resume", from: null, release: "0.4.0", releaseName: "0.4.0" });
    start({ change: "redeploy", from: "0.4.0", release: "0.4.0", releaseName: "0.4.0" });
    start({ change: "repair", from: "0.4.0", release: "0.4.0", releaseName: "0.4.0" });
    sink.emit({
      type: "step",
      step: "setup.gateway",
      status: "ok",
      data: { release: "0.4.0", repaired: true, added: ["todo"], apps: 1, was: 0 },
    });
    expect(lines()).toEqual([
      "Upgrading Ben Senescu's Gateway to 0.4.0",
      "Upgrading Ben Senescu's Gateway to commit 981c72da",
      "Installing the Gateway at apps.example.com (0.4.0)",
      "Resuming the Gateway install at apps.example.com (0.4.0)",
      "Redeploying Ben Senescu's Gateway (0.4.0)",
      "Repairing Ben Senescu's Gateway (0.4.0)",
      "Gateway now routes todo ✓",
    ]);
  });

  it("lists an action's choices, one ready command each, and no single rerun", () => {
    const { sink, problems } = human();
    sink.emit({
      type: "action_required",
      action: "choose_account",
      message: "Choose which Gateway to use\nben@example.com sees a Gateway in 2 Cloudflare accounts. Run one of:",
      data: {
        choices: [
          { label: "Ben Senescu", rerun: "pnpm everyapp setup --domain everyapp.team" },
          { label: "Every Labs", rerun: "pnpm everyapp setup --domain everylabs.dev" },
        ],
      },
    });
    expect(problems()).toEqual([
      "→ Choose which Gateway to use",
      "  ben@example.com sees a Gateway in 2 Cloudflare accounts. Run one of:",
      "  pnpm everyapp setup --domain everyapp.team  Ben Senescu",
      "  pnpm everyapp setup --domain everylabs.dev  Every Labs",
    ]);
  });

  it("puts an error's page after its fix", () => {
    const { sink, problems } = human();
    sink.emit({
      type: "error",
      code: "ZONE_NOT_FOUND",
      retryable: false,
      message: "apps.example.org isn't under a domain in this Cloudflare account\nThis account's domains: everyapp.team",
      data: {
        fix: "use a name under one of them",
        url: "https://dash.cloudflare.com/acct/domains/overview",
      },
    });
    expect(problems()).toEqual([
      "✗ apps.example.org isn't under a domain in this Cloudflare account",
      "  This account's domains: everyapp.team",
      "  Fix: use a name under one of them",
      "  https://dash.cloudflare.com/acct/domains/overview",
    ]);
  });

  it("shows progress only with --verbose, except lease and live waits", () => {
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

  it("puts problems on stderr: a headline, its detail, then what to do", () => {
    const { sink, lines, problems } = human();
    sink.emit({ type: "step", step: "app.deploy", status: "ok", data: { appId: "todo", gatewayHost: "apps.example.com" } });
    sink.emit({
      type: "warning",
      code: "CERT_PENDING",
      message: "No certificate yet.\nIt usually comes within five minutes.",
    });
    sink.emit({
      type: "error",
      code: "DNS_RECORD_CONFLICT",
      message:
        "todo.apps.example.com already points somewhere else\ntodo.apps.example.com (A 203.0.113.7).",
      retryable: false,
      data: {
        fix: "delete the record in Cloudflare (example.com → DNS)",
        rerun: "pnpm everyapp deploy --force-dns",
        authorize: true,
      },
    });

    expect(lines()).toEqual(["Deploying todo to apps.example.com"]);
    expect(problems()).toEqual([
      "! No certificate yet.",
      "  It usually comes within five minutes.",
      "✗ todo.apps.example.com already points somewhere else",
      "  todo.apps.example.com (A 203.0.113.7).",
      "  Fix: delete the record in Cloudflare (example.com → DNS)",
      "  To go ahead anyway: pnpm everyapp deploy --force-dns",
    ]);
    expect(sink.exitCode).toBe(1);
  });

  it("redraws a wait in place at a terminal, with how long it has run, and ticks it once it ends", () => {
    let now = 0;
    const { sink, stdout } = human({ terminal: true, columns: () => 120, now: () => now });
    const wait = (holder: string) =>
      sink.emit({
        type: "progress",
        step: "app.lease",
        message: `Waiting for another deploy of todo to finish (${holder})...`,
      });
    wait("Bens-MacBook-Pro, started 1m ago");
    now += 25_000;
    wait("Bens-MacBook-Pro, started 2m ago");
    expect(stdout().split("\r\x1b[2K").at(-1)).toBe(
      "Waiting for another deploy of todo to finish (Bens-MacBook-Pro, started 2m ago)... · 25s ⠋",
    );
    now += 16_000;
    sink.emit({ type: "step", step: "app.lease", status: "ok", data: { waitedFor: "deploy" } });
    // What stays on screen: each line as its last redraw left it.
    const screen = stdout()
      .split("\n")
      .map((line) => line.split("\r\x1b[2K").at(-1));
    expect(screen).toEqual(["Other deploy finished ✓ 41s", ""]);
  });

  it("shows an action the run waits for on stdout, and one it stops on with its rerun on stderr", () => {
    const { sink, lines, problems } = human();
    sink.emit({
      type: "action_required",
      action: "claim_owner",
      message: "Open this link to create the owner account\nWorks once and expires in 24h.",
      data: {
        url: "https://apps.example.com/setup#token=est_x",
        waiting: true,
        waitingFor: "the owner account",
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
      "→ Open this link to create the owner account",
      "  https://apps.example.com/setup#token=est_x",
      "  Works once and expires in 24h.",
    ]);
    expect(problems()).toEqual([
      "→ This Cloudflare account has no workers.dev subdomain yet.",
      "  https://dash.cloudflare.com/acct/workers/onboarding",
      "  Run: pnpm everyapp setup --domain apps.example.com",
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
    expect(stdout()).toContain("Building... ⠋");

    sink.emit({ type: "step", step: "app.build", status: "ok" });
    sink.emit({
      type: "step",
      step: "app.migrations",
      status: "start",
      message: "Migrating the app's database...",
    });
    expect(stdout()).toContain("Built ✓\n");
    expect(stdout().split("\r\x1b[2K").at(-1)).toBe("Migrating the database... ⠋");

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

  it("says a declined prompt dim, with nothing to do next, and exits 1", () => {
    const { sink, problems } = human();
    sink.emit({
      type: "error",
      code: "CANCELLED",
      message: "Cancelled. Nothing deleted.",
      retryable: false,
      data: {},
    });
    expect(problems()).toEqual(["Cancelled. Nothing deleted."]);
    expect(sink.exitCode).toBe(1);
  });

  it("ends a problem with a close match, the usage, and the command to run with its note", () => {
    const { sink, problems } = human();
    sink.emit({
      type: "error",
      code: "UNKNOWN_FLAG",
      message: "Unknown flag --jsn for create",
      retryable: false,
      data: { didYouMean: "--json", help: "pnpm everyapp create --help" },
    });
    sink.emit({
      type: "error",
      code: "MISSING_ARGUMENT",
      message: "Missing the SQL to run",
      retryable: false,
      data: { usage: "pnpm everyapp db query <sql> [flags]" },
    });
    sink.emit({
      type: "error",
      code: "LEASE_HELD",
      message: "A deploy of todo is still running after 5m",
      retryable: true,
      data: { rerun: "pnpm everyapp deploy", rerunNote: "once it's done" },
    });
    expect(problems()).toEqual([
      "✗ Unknown flag --jsn for create",
      "  Did you mean --json?",
      "  Run: pnpm everyapp create --help",
      "✗ Missing the SQL to run",
      "  Usage: pnpm everyapp db query <sql> [flags]",
      "✗ A deploy of todo is still running after 5m",
      "  Run: pnpm everyapp deploy once it's done",
    ]);
  });

  it("adds an error's code with --verbose, and an unexpected one's stack, its message said once", () => {
    const stack =
      "TypeError: Cannot read properties of undefined (reading 'workerName')\n    at notRoutable (src/commands/secret/index.ts:315:12)\n    at async runReported (src/lib/output/run.ts:26:5)";
    const unexpected = {
      type: "error",
      code: "UNEXPECTED",
      message:
        "everyapp hit an unexpected error\nTypeError: Cannot read properties of undefined (reading 'workerName')\nThis is a bug in everyapp, not something you did.",
      retryable: false,
      data: { stack },
    } as const;
    const quiet = human();
    quiet.sink.emit(unexpected);
    expect(quiet.problems()).not.toContain("  at notRoutable (src/commands/secret/index.ts:315:12)");

    const verbose = human({ verbose: true });
    verbose.sink.emit(unexpected);
    expect(verbose.problems()).toEqual([
      "✗ everyapp hit an unexpected error",
      "  TypeError: Cannot read properties of undefined (reading 'workerName')",
      "  This is a bug in everyapp, not something you did.",
      "  at notRoutable (src/commands/secret/index.ts:315:12)",
      "  at async runReported (src/lib/output/run.ts:26:5)",
      "  Error code: UNEXPECTED",
    ]);
  });

  it("ticks the Gateway release once downloaded or built, not when it was built before", () => {
    const { sink, lines } = human();
    sink.emit({ type: "step", step: "gateway.release", status: "start", message: "Downloading the latest Gateway release..." });
    sink.emit({ type: "step", step: "gateway.release", status: "ok", data: { release: "0.2.1", downloaded: true } });
    sink.emit({ type: "step", step: "gateway.release", status: "ok", data: { release: "0.2.1", cached: false } });
    sink.emit({ type: "step", step: "gateway.release", status: "ok", data: { release: "0.2.1", cached: true } });
    expect(lines()).toEqual(["Downloaded Gateway 0.2.1 ✓", "Built from this checkout ✓"]);
  });

  it("piped, says a long step still runs every 30 seconds", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const { sink, lines } = human({ now: () => now });
      sink.emit({
        type: "step",
        step: "gateway.release",
        status: "start",
        message: "Building the Gateway from this checkout (usually 1–2m)",
      });
      for (const _ of [1, 2, 3]) {
        now += 30_000;
        vi.advanceTimersByTime(30_000);
      }
      sink.emit({ type: "step", step: "gateway.release", status: "ok", data: { release: "0.4.0", cached: false } });
      expect(lines()).toEqual([
        "still building the Gateway from this checkout (usually 1–2m) · 30s",
        "still building the Gateway from this checkout (usually 1–2m) · 1m",
        "still building the Gateway from this checkout (usually 1–2m) · 2m",
        "Built from this checkout ✓ 1m 30s",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on Ctrl+C, says what it stops in place of the spinner, then that it stopped", async () => {
    const { sink, stdout, problems } = human({ terminal: true, columns: () => 120 });
    sink.emit({ type: "step", step: "app.migrations", status: "start", message: "Migrating the database..." });
    onInterrupt({ label: "freeing todo for other runs", async: async () => undefined });
    onInterrupt({ closing: () => "Stopped before uploading. The version that was serving still is." });
    await handleInterrupt("SIGINT", { exit: () => undefined });
    expect(stdout().split("\r\x1b[2K").at(-2)).toMatch(
      /^Freeing todo for other runs \(Ctrl\+C again to quit at once\) ⠋$/,
    );
    expect(problems()).toEqual(["Stopped before uploading. The version that was serving still is."]);
  });
});
