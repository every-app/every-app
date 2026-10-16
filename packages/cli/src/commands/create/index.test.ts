import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillSource } from "@/lib/app/skill";
import { starterTemplateDir } from "@/lib/app/starter";
import { checkoutRoot } from "@/lib/checkout";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
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
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { appId: "my-app", dir: app, next: ["cd ./my-app", "pnpm dev"] },
    });
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
  });

  it("puts the app in apps/ inside the checkout, without a repository of its own", async () => {
    const root = fakeCheckout();
    const { cf, install, deploy } = seams();

    await createApp({
      flags: { json: true },
      appIdArg: "my-app",
      out,
      cwd: root,
      root,
      cf,
      install,
      deploy,
    });

    const app = path.join(root, "apps", "my-app");
    expect(fs.existsSync(path.join(app, "everyapp.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(app, ".git"))).toBe(false);
  });

  it("deploys the new app with --deploy", async () => {
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
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { url: "https://my-app.apps.example.com" },
    });
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

    expect(
      events.flatMap((event) =>
        event["type"] === "warning" ? [event["code"]] : [],
      ),
    ).toEqual(["WORKER_TYPES_FAILED", "MIGRATIONS_FAILED"]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses a bad id, or none when it may not ask, before copying anything", async () => {
    const root = fakeCheckout();
    const cwd = tmp();
    const { cf, install, deploy } = seams();
    const run = (appIdArg?: string) =>
      createApp({
        flags: { json: true },
        appIdArg,
        out,
        cwd,
        root,
        cf,
        install,
        deploy,
      });

    await expect(run("My_App")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
    });
    await expect(run("my--app")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
    });
    await expect(run("everyapp")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
    });
    await expect(run()).rejects.toMatchObject({ code: "APP_ID_REQUIRED" });
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
    await expect(run(cwd)).rejects.toMatchObject({ code: "NESTED_APP" });

    const other = tmp();
    fs.mkdirSync(path.join(other, "my-app"));
    await expect(run(other)).rejects.toMatchObject({ code: "APP_DIR_EXISTS" });
  });
});
