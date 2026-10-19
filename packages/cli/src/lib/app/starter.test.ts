import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { copyStarter, newAppDir, starterTemplateDir } from "./starter";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-starter-")));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A checkout with the real template, plus the stray local state a
 * developer's could have, and the workspace packages it links.
 */
function fakeCheckout(): string {
  const root = tmp();
  const template = path.join(root, "templates", "simple-todo");
  fs.cpSync(starterTemplateDir(checkoutRoot()), template, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  fs.mkdirSync(path.join(template, ".cloudflare", "state"), { recursive: true });
  fs.writeFileSync(path.join(template, ".dev.vars"), "SECRET=1");
  for (const [dir, name] of [
    ["sdk", "@every-app/sdk"],
    ["cli", "everyapp"],
  ]) {
    fs.mkdirSync(path.join(root, "packages", dir!), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", dir!, "package.json"), JSON.stringify({ name }));
  }
  return root;
}

describe("the starter template", () => {
  it("is the checkout's own", () => {
    const dir = starterTemplateDir(checkoutRoot());
    expect(fs.existsSync(path.join(dir, "everyapp.config.ts"))).toBe(true);
  });

  it("goes to apps/ inside the checkout, the current directory anywhere else", () => {
    const root = fakeCheckout();
    const elsewhere = tmp();

    expect(newAppDir({ appId: "my-app", cwd: root, root })).toBe(path.join(root, "apps", "my-app"));
    expect(newAppDir({ appId: "my-app", cwd: path.join(root, "templates"), root })).toBe(
      path.join(root, "apps", "my-app"),
    );
    expect(newAppDir({ appId: "my-app", cwd: elsewhere, root })).toBe(path.join(elsewhere, "my-app"));
  });

  it("copies as the app it is asked to be, without local state, in the checkout's workspace", async () => {
    const root = fakeCheckout();
    const target = path.join(root, "apps", "my-app");

    await copyStarter({ root, targetDir: target, appId: "my-app" });

    expect(fs.readFileSync(path.join(target, "everyapp.config.ts"), "utf8")).toContain('id: "my-app"');
    const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    expect(packageJson.name).toBe("my-app");
    expect(packageJson.dependencies["@every-app/sdk"]).toBe("workspace:*");
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain(".dev.vars");
    // Its release workflow: tag v*, and everyapp deploy <its repository> installs it.
    const workflow = fs.readFileSync(path.join(target, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("pnpm everyapp deploy --bundle-only --out everyapp-release.tar.gz");
    expect(workflow).toContain('tags: ["v*"]');
    expect(fs.existsSync(path.join(target, ".cloudflare"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".dev.vars"))).toBe(false);
    // The checkout's pnpm-workspace.yaml covers it.
    expect(fs.existsSync(path.join(target, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("copies as its own pnpm workspace, linked to the checkout, anywhere else", async () => {
    const root = fakeCheckout();
    const target = path.join(tmp(), "my-app");

    await copyStarter({ root, targetDir: target, appId: "my-app" });

    const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    expect(path.resolve(target, packageJson.dependencies["@every-app/sdk"].slice("link:".length))).toBe(
      path.join(root, "packages", "sdk"),
    );
    expect(path.resolve(target, packageJson.devDependencies.everyapp.slice("link:".length))).toBe(
      path.join(root, "packages", "cli"),
    );
    expect(fs.readFileSync(path.join(target, "pnpm-workspace.yaml"), "utf8")).toContain("allowBuilds:");
  });
});
