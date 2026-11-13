import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, RotatingLog } from "../src/main/logfile";
import { buildDiagnostics } from "../src/main/diagnostics";
import { DEFAULT_SETTINGS, type AppSnapshot } from "@shared/ipc";

describe("log redaction", () => {
  it("masks tokens in every shape they show up in", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const cases = [
      "authorization: Bearer epat_abc123secretvalue",
      `got ${jwt} back`,
      "token epat_9f8e7d6c5b4a",
      '{"access_token":"at-123","refresh_token":"rt-456","token_type":"Bearer"}',
      '{"accessToken": "abc.def", "meetingId": "m1"}',
      "refresh_token=rt-789&client_id=talk",
      "http://127.0.0.1:5555/callback?code=AUTHCODE123&state=STATE456&iss=https://gw",
      "client_secret: shh-very-secret",
      "dev sign-in token=dev",
    ];
    const out = cases.map(redact).join("\n");
    for (const secret of ["epat_abc123secretvalue", jwt, "epat_9f8e7d6c5b4a", "at-123", "rt-456", "abc.def", "rt-789", "AUTHCODE123", "STATE456", "shh-very-secret", "token=dev"]) {
      expect(out, secret).not.toContain(secret);
    }
    // What helps debugging stays.
    expect(out).toContain('"meetingId": "m1"');
    expect(out).toContain("client_id=talk");
    expect(out).toContain("iss=https://gw");
  });

  it("drops transcript text and keeps error codes", () => {
    const line = '[helper] {"event":"transcript.segment","seq":3,"speaker":"them","text":"Our Q3 numbers are \\"bad\\"","startedMs":1}';
    const out = redact(line);
    expect(out).not.toContain("Q3 numbers");
    expect(out).toContain('"seq":3');
    expect(redact('{"code":"save_failed","fatal":false}')).toContain('"code":"save_failed"');
    expect(redact("helper exited (code 3, signal null)")).toContain("code 3");
  });
});

describe("rotating log", () => {
  it("writes redacted lines and keeps 3 files of at most maxBytes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "everyapp-log-")), "logs", "main.log");
    const log = new RotatingLog(path, { maxBytes: 1000, keep: 3 });
    log.write("first Bearer epat_secret123456");
    expect(readFileSync(path, "utf8")).toContain("Bearer ‹redacted›");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 100; i++) log.write(`line ${i} ${"x".repeat(80)}`);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    for (const f of [path, `${path}.1`, `${path}.2`]) expect(statSync(f).size).toBeLessThanOrEqual(1000);
    expect(log.tail(3).map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["line 97", "line 98", "line 99"]);
    expect(log.tail(15)).toHaveLength(15); // spans the rotated file
  });

  it("keeps one line per entry", () => {
    const path = join(mkdtempSync(join(tmpdir(), "everyapp-log-")), "main.log");
    const log = new RotatingLog(path);
    log.write("a\nb");
    expect(log.tail(5)).toEqual(["a ⏎ b"]);
  });
});

describe("diagnostics", () => {
  it("has what helps and nothing private", () => {
    const snapshot: AppSnapshot = {
      version: "0.1.0",
      auth: { status: "signedOut", method: "oauth", appUrl: "https://talk.example.com", email: "ben@example.com", expired: true },
      helper: { status: "ready", version: "0.1.0", macos: "26.5", restarts: 2, crashes: 2 },
      recording: { state: "recording", title: "Board meeting: layoffs", lastLine: "secret plans", meetingId: "m1", mode: "realtime", transcription: "reconnecting" },
      calendar: { connected: true, events: [] },
      tray: "attention",
      updater: { enabled: false, state: "idle" },
      recordShortcut: "off",
      selfTest: { running: false },
      settings: { ...DEFAULT_SETTINGS, ownTranscription: true, transcriptionBaseUrl: "http://studio.local:9000/v1", transcriptionModel: "large-v3" },
      transcriptionKey: { saved: true },
      connection: "signin-needed",
      permissions: { mic: "granted", systemAudio: "verified", notifications: "unknown" },
      loginItem: { status: "unsupported" },
    };
    const text = buildDiagnostics({
      snapshot,
      versions: { app: "0.1.0", electron: "45.2.1", chrome: "1", node: "22", os: "darwin 26.5", arch: "arm64" },
      recordingCrashes: 1,
      pendingUploads: 3,
      logTail: ["a line with Bearer epat_leaked12345"],
    });
    expect(text).toContain("Connection: signin-needed");
    expect(text).toContain("crashes 2, recordings cut short 1");
    expect(text).toContain("Pending uploads: 3");
    expect(text).toContain("app talk.example.com, expired");
    expect(text).toContain("transcription reconnecting");
    expect(text).toContain('"recordShortcut":false');
    expect(text).toContain('"ownTranscription":true,"transcriptionBaseUrl":"(set)"'); // on, but not where
    for (const privateBit of ["ben@example.com", "layoffs", "secret plans", "epat_leaked12345", "studio.local"]) expect(text).not.toContain(privateBit);
  });
});
