/**
 * Copy the agent docs into this package: `../../landing-page/content/agent`
 * (every page and setup guide; the repo/ mirror the site build writes is
 * left out) to `./docs/agent`, and the security page (`../../docs/security.md`)
 * as `docs/agent/repo/threat-model.md`. Runs at `build`, so the published
 * package carries the pages `everyapp docs` prints when everyapp.com can't
 * be reached (src/commands/docs). The skills point at the site; this copy
 * is only the fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(CLI_DIR, "..", "..");
const SOURCE = path.join(ROOT, "landing-page", "content", "agent");
const TARGET = path.join(CLI_DIR, "docs", "agent");

if (!fs.existsSync(path.join(SOURCE, "index.md"))) {
  console.error(`No agent docs at ${SOURCE}`);
  process.exit(1);
}
fs.rmSync(path.join(CLI_DIR, "docs"), { recursive: true, force: true });
fs.cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (file) => {
    const rel = path.relative(SOURCE, file);
    if (rel === "repo" || rel.startsWith(`repo${path.sep}`)) return false;
    return fs.statSync(file).isDirectory() || file.endsWith(".md");
  },
});
const security = path.join(ROOT, "docs", "security.md");
if (fs.existsSync(security)) {
  fs.mkdirSync(path.join(TARGET, "repo"), { recursive: true });
  const body = fs.readFileSync(security, "utf8").replace(/^# [^\n]*\n+/, "");
  fs.writeFileSync(
    path.join(TARGET, "repo", "threat-model.md"),
    `---\ntitle: "Security"\ndescription: "Who is trusted with what, the boundaries and their invariants."\n---\n\n${body}`,
  );
}
