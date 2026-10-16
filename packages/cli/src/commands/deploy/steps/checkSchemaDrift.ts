/**
 * Before an app's database is migrated: do its migrations still describe
 * its schema? A schema changed without `pnpm db:generate` deploys code
 * that expects tables and columns no migration creates.
 *
 * `drizzle-kit generate`, run with the app's own drizzle config but its
 * `out` pointed at a copy of the migrations, writes a migration exactly
 * when the schema has changes the migrations lack. So a new `.sql` file in
 * the copy is the verdict, never drizzle-kit's wording. drizzle-kit 0.31
 * refuses `--out` next to `--config`, so a two-line config next to the
 * copy extends the app's; and it resolves `out` against the working
 * directory only, so the copy lives in the app's (ignored) `.everyapp/`.
 * It runs after the build (dependencies installed) and before the database
 * or the Worker changes. A Postgres app (migrations.dialect "postgresql")
 * is checked the same way: generate needs no database.
 */
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { EveryAppError } from "@/lib/errors";
import { ensureGitignored } from "@/lib/gitignore";
import { onInterrupt } from "@/lib/interrupt";
import { resolveLocalPackage } from "@/lib/local-package-bin";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";

// drizzle-kit's own defaults, in its order.
const CONFIG_FILES = ["drizzle.config.ts", "drizzle.config.js"];
const GENERATE_TIMEOUT_MS = 120_000;

export async function checkSchemaDrift({
  cwd,
  manifest,
  out,
}: {
  cwd: string;
  manifest: EveryAppCliManifest;
  out: EventSink;
}): Promise<void> {
  // An absent `migrations` field means drizzle (lib/manifest.ts).
  const engine = manifest.migrations?.engine ?? "drizzle";
  const postgres = manifest.migrations?.dialect === "postgresql";
  if ((!postgres && !manifest.resources?.d1?.length) || engine !== "drizzle") return;
  const skip = (why: string) =>
    out.emit({
      type: "warning",
      code: "SCHEMA_CHECK_SKIPPED",
      step: "app.schema",
      message: `${why}, so this deploy can't check that ${manifest.id}'s migrations match its schema.`,
    });

  let drizzleKit: string;
  try {
    drizzleKit = (await resolveLocalPackage(cwd, "drizzle-kit", "drizzle-kit")).binPath;
  } catch {
    skip("drizzle-kit isn't installed in this app (add it to devDependencies)");
    return;
  }
  const named = manifest.migrations?.config;
  const config = await firstFile(cwd, named ? [named] : CONFIG_FILES);
  if (!config) {
    skip(
      named
        ? `This app has no ${named} (migrations.config)`
        : 'This app has no drizzle.config.ts (an app that writes its SQL by hand sets migrations.engine to "d1-sql")',
    );
    return;
  }

  out.emit({
    type: "step",
    step: "app.schema",
    status: "start",
    message: "Checking the schema against the migrations...",
  });
  const migrations = path.resolve(cwd, manifest.migrations?.dir ?? "drizzle");
  ensureGitignored(cwd, ".everyapp/");
  await fs.mkdir(path.join(cwd, ".everyapp"), { recursive: true });
  const scratch = await fs.mkdtemp(path.join(cwd, ".everyapp", "schema-check-"));
  const forget = onInterrupt({
    sync: () => rmSync(scratch, { recursive: true, force: true }),
  });
  try {
    const copy = path.join(scratch, "migrations");
    await fs.cp(migrations, copy, { recursive: true }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(copy);
    });
    const before = new Set(await sqlFiles(copy));
    const wrapper = path.join(scratch, "drizzle.config.ts");
    await fs.writeFile(
      wrapper,
      [
        `import config from ${JSON.stringify(config)};`,
        `export default { ...config, out: ${JSON.stringify(path.relative(cwd, copy).split(path.sep).join("/"))} };`,
        "",
      ].join("\n"),
    );
    // drizzle-kit's generate catches its own errors, hands them to
    // console.error and exits 0: a schema that doesn't load, or a renamed
    // column or table, which it asks about only at a terminal. Made an
    // exit code here, since the app's config may write warnings to stderr.
    const reportFailure = path.join(scratch, "report-failure.cjs");
    await fs.writeFile(
      reportFailure,
      [
        "const report = console.error;",
        "console.error = (...args) => {",
        "  if (args.some((arg) => arg instanceof Error)) process.exitCode = 1;",
        "  report(...args);",
        "};",
        "",
      ].join("\n"),
    );

    const run = await execa(
      process.execPath,
      ["--require", reportFailure, drizzleKit, "generate", "--config", wrapper],
      {
        cwd,
        stdin: "ignore",
        reject: false,
        timeout: GENERATE_TIMEOUT_MS,
        env: { NODE_NO_WARNINGS: "1" },
      },
    );

    const added = (await sqlFiles(copy)).filter((file) => !before.has(file));
    if (added.length > 0) {
      throw new EveryAppError(
        "SCHEMA_DRIFT",
        `${manifest.id}'s schema has changes its migrations don't: drizzle-kit would write a new migration for them. Run \`pnpm db:generate\`, then deploy again. Nothing was migrated or uploaded.`,
      );
    }
    // No new migration from a run that failed says nothing.
    if (run.failed) {
      const lines = run.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
      const why =
        lines.find((line) => /^\w*Error\b/.test(line)) ??
        lines.at(-1) ??
        (run.timedOut ? `no answer in ${GENERATE_TIMEOUT_MS / 1000} s` : `exit ${run.exitCode}`);
      throw new EveryAppError(
        "SCHEMA_CHECK_FAILED",
        `drizzle-kit couldn't compare ${manifest.id}'s schema with its migrations (${why}). Run \`pnpm db:generate\` in a terminal (it asks there about renamed columns and tables), then deploy again. Nothing was migrated or uploaded.`,
      );
    }
    out.emit({ type: "step", step: "app.schema", status: "ok", message: "schema in sync" });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    forget();
  }
}

async function firstFile(dir: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** The `.sql` files under `dir`, as paths relative to it (both drizzle layouts). */
async function sqlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}
