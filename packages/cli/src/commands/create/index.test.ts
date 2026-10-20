import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillSource } from "@/lib/app/skill";
import { starterTemplateDir } from "@/lib/app/starter";
import { checkoutRoot } from "@/lib/checkout";
import { FakeCf } from "@/lib/cf/fakeCf";
import { EveryAppError } from "@/lib/errors";
import { createHumanSink, createNdjsonSink, type EventSink } from "@/lib/output/events";
import { createApp } from "./index";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-create-")),
  );
  dirs.push(dir);
  return dir;
};

/** A checkout with the real template and the workspace packages it links. */
function fakeCheckout(): string {
  const root = tmp();
  fs.cpSync(
    starterTemplateDir(checkoutRoot()),
    path.join(root, "templates", "simple-todo"),
    {
      recursive: true,
      filter: (source) =>
        !source.includes("node_modules") && !source.includes(".cloudflare"),
    },
  );
  fs.cpSync(skillSource(checkoutRoot()), skillSource(root), { recursive: true });
  for (const [dir, name] of [
    ["sdk", "@every-app/sdk"],
    ["cli", "everyapp"],
  ]) {
    fs.mkdirSync(path.join(root, "packages", dir!), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", dir!, "package.json"),
      JSON.stringify({ name }),
    );
  }
  return root;
}

let events: Array<Record<string, unknown>>;
let out: EventSink;
const savedEnv = { ...process.env };

beforeEach(() => {
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
  // The new app's first commit, whatever the machine's git config says.
  const gitConfig = path.join(tmp(), "gitconfig");
  fs.writeFileSync(gitConfig, "");
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterEach(() => {
  process.env = { ...savedEnv };
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seams() {
  return {
    cf: new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    }),
    install: vi.fn(async () => undefined),
    deploy: vi.fn(async () => ({
      liveUrl: "https://my-app.apps.example.com",
      gatewayUrl: "https://apps.example.com",
      organizationId: "org_1",
      hostname: "my-app.apps.example.com",
      workerName: "every-my-app",
      versionId: "v1",
      live: true,
    })),
  };
}

describe("everyapp create", () => {
  it("scaffolds the named app for dev, without asking or contacting the Gateway", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();

    await createApp({
      flags: { json: true },
      appIdArg: "my-app",
      out,
      cwd,
      root,
      cf,
      install,
      deploy,
    });

    const app = path.join(cwd, "my-app");
    expect(
      fs.readFileSync(path.join(app, "everyapp.config.ts"), "utf8"),
    ).toContain('id: "my-app"');
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ cwd: app }));
    expect(cf.calls.map((call) => [call.args.slice(0, 3), call.cwd])).toEqual([
      [["workers", "types"], app],
      [["d1", "migrations", "apply"], app],
    ]);
    // The skill, where coding agents look for it, and the template's
    // AGENTS.md pointing at it, as it was.
    for (const dir of [".claude", ".agents"]) {
      expect(fs.readFileSync(path.join(app, dir, "skills", "everyapp", "SKILL.md"), "utf8")).toContain(
        "name: everyapp",
      );
    }
    expect(fs.readFileSync(path.join(app, "AGENTS.md"), "utf8")).toBe(
      fs.readFileSync(path.join(starterTemplateDir(root), "AGENTS.md"), "utf8"),
    );
    // Outside the checkout it is its own repository, committed.
    expect(fs.existsSync(path.join(app, ".git"))).toBe(true);
    // Nothing for the Gateway, and no env files.
    expect(deploy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(app, ".env.local"))).toBe(false);
    expect(fs.existsSync(path.join(app, ".dev.vars"))).toBe(false);
    // Every long step starts, and ends with its time.
    expect(
      events.flatMap((event) => (event["type"] === "step" ? [`${event["step"]} ${event["status"]}`] : [])),
    ).toEqual([
      "create.copy start",
      "create.copy ok",
      "create.skill ok",
      "create.install start",
      "create.install ok",
      "create.types start",
      "create.types ok",
      "migrations.local start",
      "migrations.local ok",
      "create.git start",
      "create.git ok",
    ]);
    expect(events.find((event) => event["step"] === "create.install" && event["status"] === "ok")).toMatchObject({
      message: "Installed dependencies",
      data: { ms: expect.any(Number) },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: {
        appId: "my-app",
        dir: app,
        next: [
          { command: "cd my-app" },
          { command: "pnpm dev", note: "run it locally" },
          { command: "pnpm everyapp deploy", note: "put it live" },
        ],
      },
    });
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
  });

  it("puts the app in apps/ inside the checkout, without a repository of its own, and says so away from its root", async () => {
    const root = fakeCheckout();
    const { cf, install, deploy } = seams();
    const from = path.join(root, "packages", "cli");
    let shown = "";
    const human = createHumanSink({ write: (text) => void (shown += text), writeProblem: () => undefined });

    await createApp({ flags: {}, appIdArg: "my-app", out: human, cwd: from, root, cf, install, deploy });

    const app = path.join(root, "apps", "my-app");
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(false);
    expect(stripVTControlCharacters(shown)).toBe(
      [
        "Creating my-app in ../../apps/my-app",
        "New apps go in the checkout's apps/ folder, wherever you run create.",
        "Copied the starter template ✓",
        "Added the everyapp skill for coding agents ✓",
        "Installed dependencies ✓",
        "Generated types ✓",
        "Set up the local database ✓ 1 migration",
        "",
        "Next:",
        "  cd ../../apps/my-app",
        "  pnpm dev              run it locally",
        "  pnpm everyapp deploy  put it live",
        "",
      ].join("\n"),
    );
  });

  it("deploys the new app with --deploy, the create's steps closed first", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();

    await createApp({
      flags: { json: true, deploy: true, yes: true, gateway: "https://apps.example.com" },
      appIdArg: "my-app",
      out,
      cwd,
      root,
      cf,
      install,
      deploy,
    });

    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(cwd, "my-app"),
        gateway: "https://apps.example.com",
        manifest: expect.objectContaining({ id: "my-app" }),
        out,
        // As `deploy` does: with no Gateway yet, it offers to install one
        // (-y: without asking, at a terminal).
        offerInstall: { yes: true },
      }),
    );
    expect(events.at(-2)).toMatchObject({
      type: "step",
      step: "create.done",
      status: "ok",
      message: "Created my-app in ./my-app",
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { url: "https://my-app.apps.example.com" },
    });
  });

  it("says the app was created when its deploy fails, and deploys it from its directory next", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install } = seams();
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "create", "my-app", "--deploy"];
    const run = (error: Error) =>
      createApp({
        flags: { json: true, deploy: true },
        appIdArg: "my-app",
        out,
        cwd: tmp(),
        root,
        cf,
        install,
        deploy: async () => {
          throw error;
        },
      });
    try {
      await expect(
        run(new EveryAppError("GATEWAY_NOT_FOUND", "No Gateway in the Cloudflare account Acme", { rerun: "pnpm everyapp setup --domain <hostname>" })),
      ).rejects.toMatchObject({
        code: "GATEWAY_NOT_FOUND",
        message: "No Gateway in the Cloudflare account Acme\nmy-app was created in ./my-app but isn't deployed.\nThen: cd my-app && pnpm everyapp deploy",
        rerun: "pnpm everyapp setup --domain <hostname>",
      });
      // A rerun of this command (a retry, or a takeover's flag) runs deploy there instead.
      await expect(
        run(new EveryAppError("DNS_RECORD_CONFLICT", "apps.example.com already points somewhere else")),
      ).rejects.toMatchObject({
        rerun: "cd my-app && pnpm everyapp deploy --force-dns",
        authorize: true,
      });
    } finally {
      process.argv = argv;
    }
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("still finishes when the types or the local database can't be set up", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { install, deploy } = seams();
    const cf = new FakeCf().on(() => true, {
      exitCode: 1,
      stderr: "✘ [ERROR] boom\n",
    });

    await createApp({
      flags: { json: true },
      appIdArg: "my-app",
      out,
      cwd,
      root,
      cf,
      install,
      deploy,
    });

    const warnings = events.filter((event) => event["type"] === "warning");
    expect(warnings.map((event) => event["code"])).toEqual(["WORKER_TYPES_FAILED", "MIGRATIONS_FAILED"]);
    expect(warnings[0]!["message"]).toMatch(/^Couldn't generate types\n.+\. pnpm dev tries again\.$/);
    expect(warnings[1]).toMatchObject({
      message: expect.stringMatching(/^Couldn't set up the local database\n/),
      data: { rerun: "pnpm everyapp db migrate" },
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("says the app is there when its install fails, with the end of the install's output", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, deploy } = seams();
    const tail = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
    const install = vi.fn(async () => {
      throw new EveryAppError("INSTALL_FAILED", "Installing dependencies with pnpm failed", {
        data: { command: "pnpm install", exitCode: 1, tail, log: "/tmp/everyapp/pnpm-install.log" },
      });
    });

    await expect(
      createApp({ flags: { json: true }, appIdArg: "my-app", out, cwd, root, cf, install, deploy }),
    ).rejects.toMatchObject({
      code: "INSTALL_FAILED",
      message: [
        "Couldn't install dependencies",
        "pnpm install exited 1. Its last lines:",
        "  line 4",
        "  line 5",
        "  line 6",
        "  line 7",
        "  line 8",
        "Full log: /tmp/everyapp/pnpm-install.log",
        "./my-app is created; only the install is left.",
      ].join("\n"),
      rerun: "cd my-app && pnpm install",
    });
  });

  it("finishes with a warning when git can't make the first commit", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();
    const git = vi.fn(async () => {
      throw new EveryAppError("GIT_FAILED", "Initializing the app's git repository failed", {
        data: { command: "git commit -m Starter template", tail: ["Author identity unknown"], log: "/tmp/git.log" },
      });
    });

    await createApp({ flags: { json: true }, appIdArg: "my-app", out, cwd, root, cf, install, deploy, git });

    expect(events.filter((event) => event["type"] === "warning")).toEqual([
      expect.objectContaining({
        code: "GIT_FAILED",
        message: "Couldn't make the first git commit\ngit: Author identity unknown. Full log: /tmp/git.log",
        data: { fix: "set git's user.name and user.email, then commit in ./my-app" },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(out.exitCode).toBe(0);
  });

  it("refuses a bad name, or none when it may not ask, before copying anything", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();
    const run = (appIdArg?: string, yes?: boolean) =>
      createApp({
        flags: { json: true, yes },
        appIdArg,
        out,
        cwd,
        root,
        cf,
        install,
        deploy,
      });

    await expect(run("Analytics_App")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"Analytics_App" isn\'t a valid app name',
      fix: "use lowercase letters, digits and dashes, e.g. analytics-app",
      rerun: undefined,
    });
    await expect(run("my--app")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      fix: "don't put two dashes in a row, e.g. my-app",
    });
    await expect(run("everyapp")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"everyapp" is reserved for the platform',
      fix: "pick another name",
    });
    await expect(run()).rejects.toMatchObject({
      code: "APP_ID_REQUIRED",
      message: "No app name given\nThere's no terminal to ask for one.",
      rerun: "pnpm everyapp create <name>",
    });
    await expect(run(undefined, true)).rejects.toMatchObject({
      message: "No app name given\n--yes means nothing is asked.",
      rerun: "pnpm everyapp create <name> --yes",
    });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("refuses to run inside an app, or over an existing directory", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();
    const run = (from: string) =>
      createApp({
        flags: { json: true },
        appIdArg: "my-app",
        out,
        cwd: from,
        root,
        cf,
        install,
        deploy,
      });

    fs.writeFileSync(path.join(cwd, "everyapp.config.ts"), "export default {}");
    await expect(run(cwd)).rejects.toMatchObject({
      code: "NESTED_APP",
      message: "This directory is already an app\nIt has an everyapp.config.ts. New apps go next to it, not inside it.",
      rerun: undefined,
    });

    const other = tmp();
    fs.mkdirSync(path.join(other, "my-app"));
    await expect(run(other)).rejects.toMatchObject({
      code: "APP_DIR_EXISTS",
      message: "./my-app already exists",
      fix: "pick another name, or move ./my-app away",
    });
  });
});
