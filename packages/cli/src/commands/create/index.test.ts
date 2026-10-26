import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLISHED_VERSION } from "@/lib/app/publishedVersions";
import { skillsSource } from "@/lib/app/skill";
import { starterTemplateDir } from "@/lib/app/starter";
import { checkoutRoot, type TemplateSource } from "@/lib/checkout";
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

/** The template source of a checkout at `root`. */
const sourceOf = (root: string): TemplateSource => ({
  root,
  starterDir: starterTemplateDir(root),
  skillsDir: skillsSource(root),
});

/** An installed everyapp package, with the template and skills packed in (scripts/bundle-starter.mjs). */
function fakePackage(dir: string = tmp()): TemplateSource {
  fs.cpSync(starterTemplateDir(checkoutRoot()), path.join(dir, "starter"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes(".cloudflare"),
  });
  fs.renameSync(path.join(dir, "starter", ".gitignore"), path.join(dir, "starter", "gitignore"));
  fs.cpSync(skillsSource(checkoutRoot()), path.join(dir, "skills"), { recursive: true });
  return { root: null, starterDir: path.join(dir, "starter"), skillsDir: path.join(dir, "skills") };
}

/** A checkout with the real template and the workspace packages it links. */
function fakeCheckout(root: string = tmp()): string {
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(
    starterTemplateDir(checkoutRoot()),
    path.join(root, "starter"),
    {
      recursive: true,
      filter: (source) =>
        !source.includes("node_modules") && !source.includes(".cloudflare"),
    },
  );
  fs.cpSync(skillsSource(checkoutRoot()), skillsSource(root), { recursive: true });
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
    // macOS answers ENOTEMPTY to a recursive rm now and then; retrying is the usual cure.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function seams() {
  return {
    cf: new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    }),
    install: vi.fn(async () => undefined),
  };
}

describe("everyapp create", () => {
  it("scaffolds the named app for dev, without asking or contacting the Gateway", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install } = seams();

    await createApp({
      flags: { json: true },
      appIdArg: "my-app",
      out,
      cwd,
      source: sourceOf(root),
      cf,
      install,
    });

    const app = path.join(cwd, "my-app");
    // Named after the app everywhere a person or the Gateway reads a name.
    const manifest = fs.readFileSync(path.join(app, "everyapp.config.ts"), "utf8");
    expect(manifest).toContain('id: "my-app"');
    expect(manifest).toContain('name: "My App"');
    expect(JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).name).toBe("my-app");
    expect(fs.readFileSync(path.join(app, "README.md"), "utf8").startsWith("# My App\n")).toBe(true);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ cwd: app }));
    expect(cf.calls.map((call) => [call.args.slice(0, 3), call.cwd])).toEqual([
      [["workers", "types"], app],
      [["d1", "migrations", "apply"], app],
    ]);
    // The skills, where coding agents look for them, and the template's
    // AGENTS.md pointing at them, as it was.
    for (const dir of [".claude", ".agents"]) {
      for (const name of ["everyapp", "build-every-app"]) {
        expect(fs.readFileSync(path.join(app, dir, "skills", name, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
      }
    }
    expect(fs.readFileSync(path.join(app, "AGENTS.md"), "utf8")).toBe(
      fs.readFileSync(path.join(starterTemplateDir(root), "AGENTS.md"), "utf8"),
    );
    // Outside the checkout it is its own repository, committed.
    expect(fs.existsSync(path.join(app, ".git"))).toBe(true);
    // Nothing for the Gateway, and no env files.
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
          { command: "pnpm run deploy", note: "put it live" },
        ],
      },
    });
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
  });

  it("puts the app in apps/ inside the checkout, without a repository of its own, and says so away from its root", async () => {
    const root = fakeCheckout();
    const { cf, install } = seams();
    const from = path.join(root, "packages", "cli");
    let shown = "";
    const human = createHumanSink({ write: (text) => void (shown += text), writeProblem: () => undefined });

    await createApp({ flags: {}, appIdArg: "my-app", out: human, cwd: from, source: sourceOf(root), cf, install });

    const app = path.join(root, "apps", "my-app");
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(false);
    expect(stripVTControlCharacters(shown)).toBe(
      [
        "Creating my-app in ../../apps/my-app",
        "New apps go in the checkout's apps/ folder, wherever you run create.",
        "Copied the starter template ✓",
        "Added the everyapp and build-every-app skills for coding agents ✓",
        "Installed dependencies ✓",
        "Generated types ✓",
        "Set up the local database ✓ 1 migration",
        "",
        "Next:",
        "  cd ../../apps/my-app",
        "  pnpm dev              run it locally",
        "  pnpm run deploy       put it live",
        "",
      ].join("\n"),
    );
  });

  it("still finishes when the types or the local database can't be set up", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { install } = seams();
    const cf = new FakeCf().on(() => true, {
      exitCode: 1,
      stderr: "✘ [ERROR] boom\n",
    });

    await createApp({
      flags: { json: true },
      appIdArg: "my-app",
      out,
      cwd,
      source: sourceOf(root),
      cf,
      install,
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
    const { cf } = seams();
    const tail = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
    const install = vi.fn(async () => {
      throw new EveryAppError("INSTALL_FAILED", "Installing dependencies with pnpm failed", {
        data: { command: "pnpm install", exitCode: 1, tail, log: "/tmp/everyapp/pnpm-install.log" },
      });
    });

    await expect(
      createApp({ flags: { json: true }, appIdArg: "my-app", out, cwd, source: sourceOf(root), cf, install }),
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
    const { cf, install } = seams();
    const git = vi.fn(async () => {
      throw new EveryAppError("GIT_FAILED", "Initializing the app's git repository failed", {
        data: { command: "git commit -m Starter template", tail: ["Author identity unknown"], log: "/tmp/git.log" },
      });
    });

    await createApp({ flags: { json: true }, appIdArg: "my-app", out, cwd, source: sourceOf(root), cf, install, git });

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
    const { cf, install } = seams();
    const run = (appIdArg?: string, yes?: boolean) =>
      createApp({
        flags: { json: true, yes },
        appIdArg,
        out,
        cwd,
        source: sourceOf(root),
        cf,
        install,
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
    const { cf, install } = seams();
    const run = (from: string) =>
      createApp({
        flags: { json: true },
        appIdArg: "my-app",
        out,
        cwd: from,
        source: sourceOf(root),
        cf,
        install,
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

  it("makes the app beside the checkout from ../my-app, as its own repository on the published packages", async () => {
    const outer = tmp();
    const root = fakeCheckout(path.join(outer, "every-app"));
    const { cf, install } = seams();

    await createApp({ flags: { json: true }, appIdArg: "../my-app", out, cwd: root, source: sourceOf(root), cf, install });

    const app = path.join(outer, "my-app");
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(root, "apps"))).toBe(false);
    // From npm, as an app made anywhere else is.
    const packageJson = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
    expect(packageJson.dependencies["@every-app/sdk"]).toBe(`^${PUBLISHED_VERSION}`);
    expect(packageJson.devDependencies.everyapp).toBe(`^${PUBLISHED_VERSION}`);
    expect(fs.existsSync(path.join(app, "pnpm-workspace.yaml"))).toBe(true);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ cwd: app }));
    // Said as the path was given: no note about apps/, and `cd ../my-app`.
    expect(events.find((event) => event["step"] === "create.copy" && event["status"] === "start")).toMatchObject({
      data: { appId: "my-app", shown: "../my-app", elsewhere: false },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { appId: "my-app", dir: app, next: [{ command: "cd ../my-app" }, { command: "pnpm dev" }, { command: "pnpm run deploy" }] },
    });
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
  });

  it("from an installed package (no checkout): ./<name> wherever it runs, its own repository, on the published packages", async () => {
    const source = fakePackage();
    const cwd = tmp();
    const { cf, install } = seams();

    await createApp({ flags: { json: true }, appIdArg: "my-app", out, cwd, source, cf, install });

    const app = path.join(cwd, "my-app");
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(app, "pnpm-workspace.yaml"))).toBe(true);
    const packageJson = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
    expect(packageJson.dependencies["@every-app/sdk"]).toBe(`^${PUBLISHED_VERSION}`);
    expect(packageJson.devDependencies.everyapp).toBe(`^${PUBLISHED_VERSION}`);
    expect(fs.existsSync(path.join(app, ".agents", "skills", "everyapp", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".claude", "skills", "build-every-app", "SKILL.md"))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { appId: "my-app", dir: app, next: [{ command: "cd my-app" }, { command: "pnpm dev" }, { command: "pnpm run deploy" }] },
    });
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);

    // A path is fine too; nothing is "inside a checkout" there.
    events.length = 0;
    const elsewhere = path.join(tmp(), "team", "other");
    await createApp({ flags: { json: true }, appIdArg: elsewhere, out, cwd, source, cf, install });
    expect(fs.existsSync(path.join(elsewhere, ".git"))).toBe(true);
  });

  it("takes an absolute path, or one from ~, and says it whole", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install } = seams();

    // A parent that isn't there yet is made.
    const absolute = path.join(tmp(), "team", "my-app");
    await createApp({ flags: { json: true }, appIdArg: absolute, out, cwd, source: sourceOf(root), cf, install });
    expect(fs.existsSync(path.join(absolute, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(absolute, ".git"))).toBe(true);
    expect(events.find((event) => event["step"] === "create.copy" && event["status"] === "start")).toMatchObject({
      data: { shown: absolute, elsewhere: false },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { appId: "my-app", dir: absolute, next: [{ command: `cd ${absolute}` }, { command: "pnpm dev" }, { command: "pnpm run deploy" }] },
    });

    events.length = 0;
    const home = tmp();
    await createApp({ flags: { json: true }, appIdArg: "~/apps/my-app", out, cwd, source: sourceOf(root), cf, install, home });
    const fromHome = path.join(home, "apps", "my-app");
    expect(fs.existsSync(path.join(fromHome, "everyapp.config.ts"))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { appId: "my-app", dir: fromHome, next: [{ command: `cd ${fromHome}` }, { command: "pnpm dev" }, { command: "pnpm run deploy" }] },
    });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("puts a path into the checkout's apps/ by the inside rule, from wherever it is said", async () => {
    const root = fakeCheckout();
    const { cf, install } = seams();
    const app = path.join(root, "apps", "my-app");

    await createApp({ flags: { json: true }, appIdArg: "apps/my-app", out, cwd: root, source: sourceOf(root), cf, install });
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).dependencies["@every-app/sdk"]).toBe(
      "workspace:*",
    );
    expect(events.find((event) => event["step"] === "create.copy" && event["status"] === "start")).toMatchObject({
      data: { shown: "./apps/my-app", elsewhere: false },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", data: { dir: app, next: [{ command: "cd apps/my-app" }, {}, {}] } });
    expect(events.flatMap((event) => (event["step"] === "create.git" ? [event] : []))).toEqual([]);

    fs.rmSync(app, { recursive: true });
    events.length = 0;
    const from = path.join(root, "packages", "cli");
    await createApp({ flags: { json: true }, appIdArg: "../../apps/my-app", out, cwd: from, source: sourceOf(root), cf, install });
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(events.find((event) => event["step"] === "create.copy" && event["status"] === "start")).toMatchObject({
      data: { shown: "../../apps/my-app", elsewhere: false },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", data: { dir: app, next: [{ command: "cd ../../apps/my-app" }, {}, {}] } });
  });

  it("refuses a path inside the checkout outside apps/, or whose last part isn't a name, before copying anything", async () => {
    const outer = tmp();
    const root = fakeCheckout(path.join(outer, "every-app"));
    const { cf, install } = seams();
    const run = (appIdArg: string, from = root) =>
      createApp({ flags: { json: true }, appIdArg, out, cwd: from, source: sourceOf(root), cf, install });

    await expect(run("./my-app")).rejects.toMatchObject({
      code: "APP_DIR_IN_CHECKOUT",
      message:
        "./my-app is inside your EveryApp checkout but not in its apps/ folder\nAn app inside the checkout goes in apps/<name>; one anywhere else is its own git repository.",
      fix: "use apps/my-app (inside the checkout) or ../my-app (beside it)",
      rerun: undefined,
    });
    // From a directory of the checkout, ../my-app lands in the checkout: said from there.
    await expect(run("../my-app", path.join(root, "packages", "cli"))).rejects.toMatchObject({
      code: "APP_DIR_IN_CHECKOUT",
      message: expect.stringMatching(/^\.\.\/my-app is inside your EveryApp checkout/),
      fix: "use ../../apps/my-app (inside the checkout) or ../../../my-app (beside it)",
    });
    await expect(run(path.join(root, "tools", "my-app"), tmp())).rejects.toMatchObject({
      code: "APP_DIR_IN_CHECKOUT",
      fix: `use ${path.join(root, "apps", "my-app")} (inside the checkout) or ${path.join(outer, "my-app")} (beside it)`,
    });
    await expect(run("apps/")).rejects.toMatchObject({ code: "APP_DIR_IN_CHECKOUT" });
    await expect(run("../My_App")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"My_App" isn\'t a valid app name\nAn app is named after the last part of its path, ../My_App.',
      fix: "use lowercase letters, digits and dashes, e.g. my-app",
    });
    expect(fs.readdirSync(outer)).toEqual(["every-app"]);
    expect(fs.readdirSync(root).sort()).toEqual(["packages", "starter"]);
    expect(install).not.toHaveBeenCalled();
  });
});
