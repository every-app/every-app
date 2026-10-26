/**
 * This everyapp's name and version, read from its own package.json when it
 * runs, never baked in at build time. The publish recipe sets the version
 * in package.json after nothing else is built (scripts/publish-rc.mjs), and
 * a version tsup inlined at build would drift from what npm published: on
 * 2026-10-26 the published 0.3.0-rc.6 said `everyapp 0.3.0` and asked for
 * the Gateway release gateway-v0.3.0, which doesn't exist.
 *
 * The package.json is the nearest one up from this module named
 * `everyapp`: `<package>/package.json` from the built `dist/` (a flat
 * directory of chunks) and `packages/cli/package.json` from the source.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CliPackage {
  name: string;
  version: string;
}

/** The everyapp package.json up from `moduleUrl`. */
export function readCliPackage(moduleUrl: string = import.meta.url): CliPackage {
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CliPackage>;
      if (pkg.name === "everyapp" && typeof pkg.version === "string") {
        return { name: pkg.name, version: pkg.version };
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`everyapp can't find its own package.json above ${fileURLToPath(moduleUrl)}`);
    }
  }
}

const cliPackage = readCliPackage();

/** `everyapp`. */
export const cliName = cliPackage.name;
/** This everyapp's version, as its package.json says now. */
export const cliVersion = cliPackage.version;
