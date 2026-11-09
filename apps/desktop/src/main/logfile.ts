// The main-process log file: rotating (main.log, main.log.1, main.log.2; 5 MB each) and redacted.
// Nothing secret or private goes in: bearer tokens, OAuth tokens and codes, personal access
// tokens and JWTs are masked, and transcript text (a `"text"` field, as in the helper's JSON) is
// dropped. The helper's stderr comes through here too. No Electron import (tested).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MASK = "‹redacted›";

const PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization headers and "Bearer x".
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  // JWTs (three base64url parts, the first starting eyJ).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
  // Personal access tokens and similar prefixed secrets.
  [/\b(epat|sk|rk|ek)_[A-Za-z0-9_-]{6,}/g, MASK],
  // key=value / "key": "value" for anything that names a secret.
  [
    /(["']?)((?:access|refresh|id)_?token|accessToken|refreshToken|token|client_secret|code_verifier|password|secret|authorization|api_?key)\1(\s*[:=]\s*)(["']?)([^"'&\s,}]+)\4/gi,
    (_m, q, key, sep, vq) => `${q}${key}${q}${sep}${vq}${MASK}${vq}`,
  ],
  // OAuth codes in URLs (?code=…&state=…). A bare "code" elsewhere is an error code, kept.
  [/([?&](?:code|state|token|access_token|refresh_token)=)[^&\s#"']+/gi, `$1${MASK}`],
  // Transcript text: "text": "…" (helper events or anything echoing them).
  [/("text"\s*:\s*)"(?:[^"\\]|\\.)*"/g, `$1"‹transcript›"`],
];

/** A log line with secrets masked and transcript text removed. */
export function redact(line: string): string {
  let out = line;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement as never);
  return out;
}

export interface RotatingLogOptions {
  maxBytes?: number;
  /** Files kept, counting the live one: 3 = main.log, main.log.1, main.log.2. */
  keep?: number;
}

export class RotatingLog {
  private size = -1;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    readonly path: string,
    options: RotatingLogOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, options.keep ?? 3);
  }

  /** Appends one redacted line, rotating first when the file is full. */
  write(line: string): void {
    const text = `${redact(line).replace(/\r?\n/g, " ⏎ ")}\n`;
    try {
      if (this.size < 0) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.size = existsSync(this.path) ? statSync(this.path).size : 0;
      }
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.path, text, { mode: 0o600 });
      this.size += bytes;
    } catch {
      // Logging must never break the app.
    }
  }

  /** The last `n` lines (the live file, then the previous one if needed). */
  tail(n: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.keep && lines.length < n; i++) {
      const file = i === 0 ? this.path : `${this.path}.${i}`;
      try {
        const content = readFileSync(file, "utf8").split("\n").filter(Boolean);
        lines.unshift(...content.slice(-(n - lines.length)));
      } catch {
        break;
      }
    }
    return lines.slice(-n);
  }

  private rotate(): void {
    rmSync(`${this.path}.${this.keep - 1}`, { force: true });
    for (let i = this.keep - 2; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    if (this.keep > 1) renameSync(this.path, `${this.path}.1`);
    else rmSync(this.path, { force: true });
    this.size = 0;
  }
}
