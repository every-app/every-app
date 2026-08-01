import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBundledGatewayTarballPath } from "./gateway-release";

describe("resolveBundledGatewayTarballPath", () => {
  it("resolves the bundled tarball from the built CLI dist directory", async () => {
    const packageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "everyapp-cli-package-test-"),
    );
    const distEntry = path.join(packageRoot, "dist", "index.js");
    const expectedTarball = path.join(
      packageRoot,
      "gateway",
      "every-app-gateway-build.tar.gz",
    );
    await fs.mkdir(path.dirname(distEntry), { recursive: true });
    await fs.mkdir(path.dirname(expectedTarball), { recursive: true });
    await fs.writeFile(distEntry, "", "utf-8");
    await fs.writeFile(expectedTarball, "", "utf-8");

    expect(
      resolveBundledGatewayTarballPath(pathToFileURL(distEntry).href),
    ).toBe(expectedTarball);
  });
});
