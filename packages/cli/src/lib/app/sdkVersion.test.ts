import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { appSdk, warnSdkVersion } from "./sdkVersion";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sdk-"));
  dirs.push(dir);
  return dir;
}

/** An SDK package at `version` in `dir`. */
function sdkPackage(dir: string, version: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@every-app/sdk", version }));
}

/** An app directory with @every-app/sdk at `version` installed, or linked from a checkout's, or none. */
function app(version?: string, { linked = false } = {}): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "todo" }));
  if (version) {
    const installed = path.join(dir, "node_modules", "@every-app", "sdk");
    if (linked) {
      // What `pnpm link ../private-every-app/packages/sdk` leaves: a symlink out of node_modules.
      const checkoutSdk = path.join(tempDir(), "packages", "sdk");
      sdkPackage(checkoutSdk, version);
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.symlinkSync(checkoutSdk, installed, "dir");
    } else {
      sdkPackage(installed, version);
    }
  }
  return dir;
}

function warnings(cwd: string, cli: string): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  warnSdkVersion(cwd, createNdjsonSink((line) => events.push(JSON.parse(line))), cli);
  return events;
}

describe("warnSdkVersion", () => {
  it("warns of an SDK from another release, older or newer, and says nothing for the same one", () => {
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
    expect(warnings(app("0.3.0"), "0.3.0-rc.15")[0]?.["message"]).toContain("newer than this everyapp");
    expect(warnings(app("0.3.0-rc.10"), "0.3.0-rc.10")).toEqual([]);
  });

  it("says nothing for an SDK linked from a checkout, whatever its version", () => {
    expect(appSdk(app("0.3.0-rc.9", { linked: true }))).toEqual({ version: "0.3.0-rc.9", linked: true });
    expect(warnings(app("0.3.0-rc.9", { linked: true }), "0.3.0-rc.15")).toEqual([]);
    expect(appSdk(app("0.3.0-rc.9"))).toEqual({ version: "0.3.0-rc.9", linked: false });
  });

  it("says nothing for an app with no SDK installed", () => {
    expect(warnings(app(), "0.3.0-rc.15")).toEqual([]);
  });
});
