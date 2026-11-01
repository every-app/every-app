/**
 * tsup inlines the workspace packages in package.json's `tsup.noExternal`
 * into dist/ and externalizes exactly the CLI's declared dependencies, so an
 * inlined package's `import "zod"` resolves from the CLI's node_modules at
 * run time, under the CLI's range, not the package's own. On 2026-10-24 the
 * perimeter declared zod ^3 and every test ran its manifest schema under
 * zod 3 while the built CLI ran it under zod 4, refusing every capability
 * without scope sets (#543) with CI green. So: a dependency an inlined
 * package shares with the CLI must be declared with the identical range.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = path.resolve(CLI_DIR, "..");

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  tsup?: { noExternal?: string[] };
}

const readPackage = (dir: string): PackageJson =>
  JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;

describe("the packages tsup inlines into dist/", () => {
  const cli = readPackage(CLI_DIR);
  const inlined = cli.tsup?.noExternal ?? [];
  const workspace = new Map(
    fs
      .readdirSync(PACKAGES_DIR)
      .map((entry) => path.join(PACKAGES_DIR, entry))
      .filter((dir) => fs.existsSync(path.join(dir, "package.json")))
      .map((dir) => [readPackage(dir).name, dir] as const),
  );

  it("are workspace packages", () => {
    expect(inlined).toEqual(expect.arrayContaining(["@every-app/perimeter", "@every-app/sdk", "@every-app/toolbus"]));
    for (const name of inlined) expect(workspace.has(name), `${name} is not under packages/`).toBe(true);
  });

  it.each(inlined)("%s declares every dependency it shares with the CLI at the CLI's range", (name) => {
    const pkg = readPackage(workspace.get(name)!);
    const cliRanges = cli.dependencies ?? {};
    const drift: string[] = [];
    const shared: string[] = [];
    for (const [dep, range] of Object.entries({ ...pkg.peerDependencies, ...pkg.dependencies })) {
      if (range.startsWith("workspace:") || !(dep in cliRanges)) continue;
      shared.push(dep);
      if (range !== cliRanges[dep]) drift.push(`${dep}: ${name} declares ${range}, the CLI ${cliRanges[dep]}`);
    }
    expect(drift, "an inlined package runs its shared dependencies from the CLI's node_modules").toEqual([]);
    // The perimeter's manifest schema is the case that bit: it must be among the compared pairs.
    if (name === "@every-app/perimeter") expect(shared).toContain("zod");
  });
});
