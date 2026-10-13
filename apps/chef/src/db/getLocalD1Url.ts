import fs from "fs";
import path from "path";

/**
 * Resolve the local D1 sqlite file `cf dev` serves, for drizzle-kit (studio).
 * It exists once `pnpm dev` or `pnpm run db:migrate:local` has run.
 */
export function getLocalD1Url(): string | null {
  const d1Path = path.resolve(
    ".cloudflare",
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
  );
  const files = fs.existsSync(d1Path)
    ? fs
        .readdirSync(d1Path, { encoding: "utf-8", recursive: true })
        // Miniflare keeps a metadata.sqlite next to the databases.
        .filter(
          (file) =>
            file.endsWith(".sqlite") &&
            path.basename(file) !== "metadata.sqlite",
        )
        .map((file) => ({
          file,
          stats: fs.statSync(path.join(d1Path, file)),
        }))
        .filter(({ stats }) => stats.isFile())
        .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    : [];

  if (files.length === 0) {
    console.error(
      "WARNING: no local D1 database yet — run `pnpm run db:migrate:local` (or `pnpm dev`) first.",
    );
    return null;
  }
  if (files.length > 1) {
    console.warn(
      `WARNING: multiple local D1 files found; using ${files[0]!.file}.`,
    );
  }
  return path.join(d1Path, files[0]!.file);
}
