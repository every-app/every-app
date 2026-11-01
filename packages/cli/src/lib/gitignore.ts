import fs from "node:fs";
import path from "node:path";

/** Add `entry` to the app's .gitignore unless a line already covers it. */
export function ensureGitignored(appDir: string, entry: string): void {
  const file = path.join(appDir, ".gitignore");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, entry + "\n");
    return;
  }
  const content = fs.readFileSync(file, "utf-8");
  const present = content
    .split("\n")
    .some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""));
  if (!present) {
    fs.appendFileSync(
      file,
      (content.endsWith("\n") ? "" : "\n") + entry + "\n",
    );
  }
}
