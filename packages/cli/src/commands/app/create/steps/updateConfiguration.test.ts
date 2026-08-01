import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  updateEveryappManifestId,
  updatePackageJson,
} from "./updateConfiguration";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const simpleTodoTemplatePath = path.resolve(
  __dirname,
  "../../../../../../../templates/simple-todo",
);

describe("updateEveryappManifestId", () => {
  it("rewrites the simple-todo manifest id", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-template-"));
    const targetDir = path.join(tempDir, "simple-todo");

    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(
        path.join(simpleTodoTemplatePath, "everyapp.config.ts"),
        path.join(targetDir, "everyapp.config.ts"),
      );

      await updateEveryappManifestId({ targetDir, appId: "my-new-app" });

      const manifest = await fs.readFile(
        path.join(targetDir, "everyapp.config.ts"),
        "utf-8",
      );
      expect(manifest).toContain('id: "my-new-app"');
      await expect(
        fs.access(path.join(targetDir, "wrangler.jsonc")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("updatePackageJson", () => {
  it("preserves published dependency specs and rejects workspace specs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-template-"));
    const targetDir = path.join(tempDir, "simple-todo");

    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(
        path.join(simpleTodoTemplatePath, "package.json"),
        path.join(targetDir, "package.json"),
      );

      await updatePackageJson({ targetDir, appId: "my-new-app" });

      const packageJson = JSON.parse(
        await fs.readFile(path.join(targetDir, "package.json"), "utf-8"),
      );
      expect(packageJson.name).toBe("my-new-app");
      const specs = JSON.stringify({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      });
      // Assert the shape, not the numbers: pinning the exact ranges here couples
      // a CLI unit test to the template's package.json on every version bump.
      expect(specs).not.toContain("workspace:");
      expect(packageJson.dependencies["@every-app/sdk"]).toMatch(/^\^?\d+\./);
      expect(packageJson.devDependencies.everyapp).toMatch(/^\^?\d+\./);

      await fs.writeFile(
        path.join(targetDir, "package.json"),
        JSON.stringify({
          name: "x",
          devDependencies: { everyapp: "workspace:^" },
        }),
        "utf-8",
      );
      await expect(
        updatePackageJson({ targetDir, appId: "my-new-app" }),
      ).rejects.toThrow(/unresolvable workspace spec/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
