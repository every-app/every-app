/**
 * Keeps results in the short form (docs/cli-output.md). A command ends
 * with `finish()` (lib/output/result.ts), which can't print a paragraph by
 * default. The files below still write their `done` event by hand; the
 * numbers only go down. A static scan of the source: nothing runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Hand-written `done` events per file. Lower a number when you move one to `finish()`; never raise one. */
const BY_HAND: Readonly<Record<string, number>> = {
  "commands/access/index.ts": 4,
  "commands/ai/index.ts": 1,
  "commands/call/index.ts": 1,
  "commands/create/index.ts": 1,
  "commands/db/index.ts": 2,
  "commands/db/restore.ts": 1,
  "commands/delete/index.ts": 1,
  "commands/deploy/index.ts": 1,
  "commands/dev/link.ts": 2,
  "commands/dev/token.ts": 1,
  "commands/docs/index.ts": 3,
  "commands/email/index.ts": 2,
  "commands/events/index.ts": 1,
  "commands/install/index.ts": 2,
  "commands/login/index.ts": 2,
  "commands/mcp/index.ts": 2,
  "commands/provider/index.ts": 3,
  "commands/provider/oauth.ts": 3,
  "commands/release/index.ts": 1,
  "commands/secret/index.ts": 4,
  "commands/setup/index.ts": 4,
  "commands/signin/index.ts": 2,
  "commands/status/index.ts": 2,
  "commands/teardown/index.ts": 3,
  "lib/gatewayApi/command.ts": 1,
};

/** Every source file under `dir` that isn't a test, and not the output library itself. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join(SRC, "lib/output") || entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("CLI results", () => {
  it("end with finish(), except where they already wrote done by hand", () => {
    const found: Record<string, number> = {};
    for (const file of sources(SRC)) {
      const count = readFileSync(file, "utf8").match(/type:\s*"done"/g)?.length ?? 0;
      if (count > 0) found[relative(SRC, file)] = count;
    }
    const more = Object.entries(found).filter(([file, count]) => count > (BY_HAND[file] ?? 0));
    const fewer = Object.entries(BY_HAND).filter(([file, count]) => (found[file] ?? 0) < count);
    expect(
      more.map(([file]) => file),
      "These files emit a `done` event by hand. End the command with finish() from @/lib/output/result instead (docs/cli-output.md).",
    ).toEqual([]);
    expect(
      fewer.map(([file]) => `${file}: ${found[file] ?? 0}`),
      "These files write fewer `done` events by hand than BY_HAND in this test says. Lower their numbers to these (remove the line at 0).",
    ).toEqual([]);
  });
});
