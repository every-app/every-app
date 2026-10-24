/**
 * The @every-app/sdk version an app's release and hosted upload are stamped
 * with: read from the SDK the app has installed, through the SDK's exports
 * map (which must expose its package.json for that), or null without one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSdkVersion } from "./hostedBundle";

/** The workspace's SDK, as pnpm links it into an app's node_modules. */
const SDK = fileURLToPath(new URL("../../../../sdk/", import.meta.url));

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-sdk-version-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("appSdkVersion", () => {
  it("reads the version of the @every-app/sdk the app has installed", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@every-app/sdk": "workspace:*" } }),
    );
    await fs.mkdir(path.join(cwd, "node_modules", "@every-app"), { recursive: true });
    await fs.symlink(SDK, path.join(cwd, "node_modules", "@every-app", "sdk"), "dir");
    const { version } = JSON.parse(await fs.readFile(path.join(SDK, "package.json"), "utf8")) as {
      version: string;
    };

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(appSdkVersion(cwd)).toBe(version);
  });

  it("is null for an app without the SDK installed", async () => {
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    expect(appSdkVersion(cwd)).toBeNull();
  });
});
