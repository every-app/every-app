/**
 * Small helpers the claude -p harnesses share (test/setup-skills/run.mjs,
 * test/build-skill/run.mjs): JSON files, dotted paths, excerpts, run
 * directories. Plain Node, no dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where a harness keeps its runs: /tmp/<name>/ (macOS's per-user tmp is long and hidden). */
export function runsRootFor(name) {
  return path.join(os.tmpdir().startsWith("/var/folders") ? "/tmp" : os.tmpdir(), name);
}

/** The next free `<runsRoot>/<name>-<n>`, created. */
export function nextRunDir(runsRoot, name) {
  fs.mkdirSync(runsRoot, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(runsRoot, `${name}-${n}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      return dir;
    }
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function getPath(object, dotted) {
  return dotted.split(".").reduce((at, key) => (at == null ? undefined : at[key]), object);
}

export function setPath(object, dotted, value) {
  const keys = dotted.split(".");
  let at = object;
  for (const key of keys.slice(0, -1)) at = at[key] ??= {};
  at[keys.at(-1)] = value;
}

/** One line of `text`, whitespace folded, cut at `length`. */
export function excerpt(text, length = 240) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** `text` cut at `max` characters, each line indented by `spaces`. */
export function indent(text, spaces, max) {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return cut.split("\n").map((line) => `${" ".repeat(spaces)}${line}`).join("\n");
}

export function fmtDuration(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
