import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  updateEveryappManifestId,
  updatePackageJson,
} from "./updateConfiguration";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const simpleTodoTemplatePath = path.resolve(
  __dirname,
  "../../../../../../templates/simple-todo",
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

describe("updateEveryappManifestId", () => {
  it("rewrites the simple-todo manifest id", async () => {
    const targetDir = path.join(await tmp(), "simple-todo");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(
      path.join(simpleTodoTemplatePath, "everyapp.config.ts"),
      path.join(targetDir, "everyapp.config.ts"),
    );

    await updateEveryappManifestId({ targetDir, appId: "my-new-app" });

    const manifest = await fs.readFile(path.join(targetDir, "everyapp.config.ts"), "utf-8");
    expect(manifest).toContain('id: "my-new-app"');
    await expect(fs.access(path.join(targetDir, "wrangler.jsonc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
