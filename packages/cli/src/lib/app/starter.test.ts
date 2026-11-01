import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutRoot, type TemplateSource } from "@/lib/checkout";
import { PUBLISHED_VERSION } from "./publishedVersions";
import { skillsSource } from "./skill";
import { copyStarter, newAppDir, starterTemplateDir } from "./starter";

/** The template source of a checkout at `root`. */
const sourceOf = (root: string): TemplateSource => ({
  root,
  starterDir: starterTemplateDir(root),
  skillsDir: skillsSource(root),
});

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
  const template = path.join(root, "starter");
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
    expect(newAppDir({ appId: "my-app", cwd: path.join(root, "starter"), root })).toBe(
      path.join(root, "apps", "my-app"),
    );
    expect(newAppDir({ appId: "my-app", cwd: elsewhere, root })).toBe(path.join(elsewhere, "my-app"));
  });

  it("copies as the app it is asked to be, without local state, in the checkout's workspace", async () => {
    const root = fakeCheckout();
    const target = path.join(root, "apps", "my-app");

    await copyStarter({ source: sourceOf(root), targetDir: target, appId: "my-app" });

    expect(fs.readFileSync(path.join(target, "everyapp.config.ts"), "utf8")).toContain('id: "my-app"');
    const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    expect(packageJson.name).toBe("my-app");
    expect(packageJson.dependencies["@every-app/sdk"]).toBe("workspace:*");
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain(".dev.vars");
    // No Release workflow: a workspace package of the checkout isn't a
    // repository of its own.
    expect(fs.existsSync(path.join(starterTemplateDir(root), ".github", "workflows", "release.yml"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".cloudflare"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".dev.vars"))).toBe(false);
    // The checkout's pnpm-workspace.yaml covers it.
    expect(fs.existsSync(path.join(target, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("copies as its own pnpm workspace, linked to the checkout, beside it", async () => {
    const root = fakeCheckout();
    const target = path.join(tmp(), "my-app");

    const dependencies = await copyStarter({ source: sourceOf(root), targetDir: target, appId: "my-app" });

    expect(dependencies).toEqual({ kind: "linked", root: fs.realpathSync(root) });
    const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    expect(packageJson.dependencies["@every-app/sdk"]).toMatch(/^link:/);
    expect(packageJson.devDependencies.everyapp).toMatch(/^link:/);
    // Its lockfile is committed: the template's .gitignore doesn't ignore it.
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).not.toMatch(/^pnpm-lock\.yaml$/m);
    // No Release workflow: a linked app installs only next to the checkout.
    expect(fs.existsSync(path.join(target, ".github"))).toBe(false);
    // Its own pnpm-workspace.yaml allows the build scripts the checkout's
    // does, so `pnpm install` there doesn't warn about ignored builds.
    const workspace = fs.readFileSync(path.join(target, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toBe("allowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\n");
    const checkoutAllows = [
      ...fs.readFileSync(path.join(checkoutRoot(), "pnpm-workspace.yaml"), "utf8").matchAll(/^  ([\w-]+): true$/gm),
    ].map((match) => match[1]);
    expect(checkoutAllows).not.toEqual([]);
    for (const name of checkoutAllows) expect(workspace).toContain(`  ${name}: true\n`);
  });

  it("copies from an installed package, with no checkout: its own workspace, on the published packages, .gitignore back", async () => {
    // What scripts/bundle-starter.mjs packs: the template with its .gitignore as `gitignore`.
    const pkg = tmp();
    fs.cpSync(starterTemplateDir(checkoutRoot()), path.join(pkg, "starter"), {
      recursive: true,
      filter: (source) => !source.includes("node_modules") && !source.includes(".cloudflare"),
    });
    fs.renameSync(path.join(pkg, "starter", ".gitignore"), path.join(pkg, "starter", "gitignore"));
    const target = path.join(tmp(), "my-app");

    await copyStarter({
      source: { root: null, starterDir: path.join(pkg, "starter"), skillsDir: path.join(pkg, "skills") },
      targetDir: target,
      appId: "my-app",
    });

    const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    expect(packageJson.name).toBe("my-app");
    expect(packageJson.dependencies["@every-app/sdk"]).toBe(`^${PUBLISHED_VERSION}`);
    expect(packageJson.devDependencies.everyapp).toBe(`^${PUBLISHED_VERSION}`);
    expect(JSON.stringify(packageJson)).not.toContain("workspace:");
    expect(JSON.stringify(packageJson)).not.toContain("link:");
    expect(fs.existsSync(path.join(target, ".gitignore"))).toBe(true);
    // Its own repository on npm ranges: the Release workflow comes with it.
    expect(fs.existsSync(path.join(target, ".github", "workflows", "release.yml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(target, "pnpm-workspace.yaml"))).toBe(true);
    // Its own repository on npm ranges: the Release workflow comes with it,
    // and the lockfile its --frozen-lockfile install needs isn't ignored.
    expect(fs.readFileSync(path.join(target, ".github", "workflows", "release.yml"), "utf8")).toContain(
      "pnpm exec everyapp release --publish",
    );
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).not.toContain("pnpm-lock.yaml");
    expect(newAppDir({ appId: "my-app", cwd: "/somewhere", root: null })).toBe(path.join("/somewhere", "my-app"));
  });
});
