/**
 * A HOME for tests. The CLI runs cf below `~/.everyapp` and refuses a home
 * with a directory above it that other users can write to
 * (lib/cf/privateDir.ts), so where the temp directory is the shared `/tmp`
 * (Linux), test homes live in this package's node_modules/.cache instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_CACHE = fileURLToPath(
  new URL("../../node_modules/.cache/everyapp-test-homes", import.meta.url),
);

function othersCanWriteAbove(dir: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  for (let current = fs.realpathSync(dir); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if ((stat.uid !== uid && stat.uid !== 0) || stat.mode & 0o022) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** A new, empty home directory; the caller removes it. */
export function makeTestHome(): string {
  const base = othersCanWriteAbove(os.tmpdir()) ? PACKAGE_CACHE : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "everyapp-home-"));
}
