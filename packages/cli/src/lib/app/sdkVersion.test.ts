import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { warnSdkVersion } from "./sdkVersion";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app directory with @every-app/sdk at `version` installed, or none. */
function app(version?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sdk-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "todo" }));
  if (version) {
    const sdk = path.join(dir, "node_modules", "@every-app", "sdk");
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@every-app/sdk", version }));
  }
  return dir;
}

function warnings(cwd: string, cli: string, pin = cli): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  warnSdkVersion(cwd, createNdjsonSink((line) => events.push(JSON.parse(line))), { cli, pin });
  return events;
}

describe("warnSdkVersion", () => {
  it("warns of an SDK from another rc, older or newer, and says nothing for the same one", () => {
    expect(warnings(app("0.3.0-rc.9"), "0.3.0-rc.10")).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "SDK_VERSION_MISMATCH",
        message:
          "This app's @every-app/sdk is 0.3.0-rc.9, older than this everyapp (0.3.0-rc.10)\nThey are released together: pin both to one version (pnpm add @every-app/sdk@0.3.0-rc.10 everyapp@0.3.0-rc.10).",
        data: { sdkVersion: "0.3.0-rc.9", cliVersion: "0.3.0-rc.10", pin: "0.3.0-rc.10" },
      }),
    ]);
    expect(warnings(app("0.3.0-rc.11"), "0.3.0-rc.10")[0]?.["message"]).toContain("newer than this everyapp");
    expect(warnings(app("0.3.0-rc.10"), "0.3.0-rc.10")).toEqual([]);
  });

  it("from a checkout, compares an npm-pinned app with the newest published version, and a linked SDK with nothing", () => {
    // The checkout's package.json says 0.3.0; rc.11 is the newest on npm.
    expect(warnings(app("0.3.0-rc.11"), "0.3.0", "0.3.0-rc.11")).toEqual([]);
    expect(warnings(app("0.3.0"), "0.3.0", "0.3.0-rc.11")).toEqual([]);
    expect(warnings(app("0.3.0-rc.3"), "0.3.0", "0.3.0-rc.11")[0]?.["message"]).toMatch(
      /^This app's @every-app\/sdk is 0\.3\.0-rc\.3, older than the published everyapp \(0\.3\.0-rc\.11\)\n/,
    );
  });
});
