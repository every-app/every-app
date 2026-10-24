import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appNameFor,
  updateEveryappManifest,
  updatePackageJson,
  updateReadme,
} from "./updateConfiguration";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const simpleTodoTemplatePath = path.resolve(
  __dirname,
  "../../../../../../starter",
);

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-template-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A checkout with just the workspace packages the template links. */
async function fakeCheckout(): Promise<string> {
  const root = await tmp();
  for (const [dir, name] of [
    ["sdk", "@every-app/sdk"],
    ["cli", "everyapp"],
  ]) {
    await fs.mkdir(path.join(root, "packages", dir!), { recursive: true });
    await fs.writeFile(
      path.join(root, "packages", dir!, "package.json"),
      JSON.stringify({ name }),
    );
  }
  return root;
}

/** The template's package.json, copied into `targetDir`. */
async function copiedPackageJson(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(
    path.join(simpleTodoTemplatePath, "package.json"),
    path.join(targetDir, "package.json"),
  );
}

async function readPackageJson(targetDir: string) {
  return JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf-8"));
}

describe("appNameFor", () => {
  it("capitalizes each word of the id", () => {
    expect(appNameFor("my-app")).toBe("My App");
    expect(appNameFor("crm2")).toBe("Crm2");
    expect(appNameFor("team-crm-v2")).toBe("Team Crm V2");
  });
});

describe("updateEveryappManifest", () => {
  /** The template's everyapp.config.ts, copied into a new app directory. */
  async function copiedManifest(): Promise<string> {
    const targetDir = path.join(await tmp(), "simple-todo");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(
      path.join(simpleTodoTemplatePath, "everyapp.config.ts"),
      path.join(targetDir, "everyapp.config.ts"),
    );
    return targetDir;
  }

  it("names the simple-todo manifest after the app, and keeps its description", async () => {
    const targetDir = await copiedManifest();

    await updateEveryappManifest({ targetDir, appId: "my-new-app" });

    const manifest = await fs.readFile(path.join(targetDir, "everyapp.config.ts"), "utf-8");
    expect(manifest).toContain('id: "my-new-app"');
    expect(manifest).toContain('name: "My New App"');
    expect(manifest).not.toContain("Simple Todo");
    expect(manifest).toContain('description: "A simple todo list backed by D1 and KV."');
    await expect(fs.access(path.join(targetDir, "wrangler.jsonc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a manifest without an id or a name to rewrite", async () => {
    const targetDir = await tmp();
    const manifestPath = path.join(targetDir, "everyapp.config.ts");

    await fs.writeFile(manifestPath, 'export default { name: "X" } as const;\n');
    await expect(updateEveryappManifest({ targetDir, appId: "my-new-app" })).rejects.toThrow(
      /id field/,
    );
    await fs.writeFile(manifestPath, 'export default { id: "x" } as const;\n');
    await expect(updateEveryappManifest({ targetDir, appId: "my-new-app" })).rejects.toThrow(
      /name field/,
    );
  });
});

describe("updateReadme", () => {
  it("titles the simple-todo README after the app, and nothing else", async () => {
    const targetDir = await tmp();
    await fs.copyFile(
      path.join(simpleTodoTemplatePath, "README.md"),
      path.join(targetDir, "README.md"),
    );
    const before = await fs.readFile(path.join(targetDir, "README.md"), "utf-8");
    expect(before.startsWith("# Every App\n")).toBe(true);

    await updateReadme({ targetDir, appId: "my-new-app" });

    const readme = await fs.readFile(path.join(targetDir, "README.md"), "utf-8");
    expect(readme).toBe(before.replace("# Every App\n", "# My New App\n"));
  });

  it("retitles only the first H1", async () => {
    const targetDir = await tmp();
    await fs.writeFile(
      path.join(targetDir, "README.md"),
      "Intro line\n\n# One\n\n## Section\n\n# Two\n",
    );

    await updateReadme({ targetDir, appId: "crm2" });

    expect(await fs.readFile(path.join(targetDir, "README.md"), "utf-8")).toBe(
      "Intro line\n\n# Crm2\n\n## Section\n\n# Two\n",
    );
  });

  it("leaves a template without a README alone", async () => {
    const targetDir = await tmp();

    await updateReadme({ targetDir, appId: "my-new-app" });

    expect(await fs.readdir(targetDir)).toEqual([]);
  });
});

describe("updatePackageJson", () => {
  it("keeps the workspace packages of an app inside the checkout", async () => {
    const root = await fakeCheckout();
    const targetDir = path.join(root, "apps", "my-new-app");
    await copiedPackageJson(targetDir);

    await updatePackageJson({ targetDir, appId: "my-new-app", root });

    const packageJson = await readPackageJson(targetDir);
    expect(packageJson.name).toBe("my-new-app");
    expect(packageJson.dependencies["@every-app/sdk"]).toBe("workspace:*");
    expect(packageJson.devDependencies.everyapp).toBe("workspace:*");
    expect(packageJson.scripts.dev).toBe("everyapp dev");
    expect(packageJson.scripts.deploy).toBe("everyapp deploy");
  });

  it("links the workspace packages from the checkout for an app outside it", async () => {
    const root = await fakeCheckout();
    const targetDir = path.join(await tmp(), "my-new-app");
    await copiedPackageJson(targetDir);

    await updatePackageJson({ targetDir, appId: "my-new-app", root });

    const packageJson = await readPackageJson(targetDir);
    const linked = (spec: string) => {
      expect(spec).toMatch(/^link:\.\.\//);
      return path.resolve(targetDir, spec.slice("link:".length));
    };
    expect(await fs.realpath(linked(packageJson.dependencies["@every-app/sdk"]))).toBe(
      await fs.realpath(path.join(root, "packages", "sdk")),
    );
    expect(await fs.realpath(linked(packageJson.devDependencies.everyapp))).toBe(
      await fs.realpath(path.join(root, "packages", "cli")),
    );
    expect(JSON.stringify(packageJson)).not.toContain("workspace:");
  });

  it("refuses a workspace package the checkout doesn't have", async () => {
    const root = await fakeCheckout();
    const targetDir = path.join(await tmp(), "my-new-app");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      path.join(targetDir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { "@every-app/nope": "workspace:*" } }),
    );

    await expect(
      updatePackageJson({ targetDir, appId: "my-new-app", root }),
    ).rejects.toThrow(/@every-app\/nope/);
  });
});
