#!/usr/bin/env node
// A stand-in for everyapp-helper that speaks helper protocol v1 (docs/desktop-plan.md) without
// touching audio. For the unit tests and for running the app without the Swift build.
//
// It fakes a transcript (a line every few seconds per speaker) and, like the real helper, posts
// the segments to `{apiBase}/api/v1/meetings/:id/segments` (in batches of at most 50, every 10 s
// and on stop) with the bearer it was given and calls `/finish` on stop. A failed post keeps the
// segments for the next try. A stop that still can't post them hands them back as `unsaved`
// (`finished: false`, no /finish), as the real helper does. So against `everyapp dev` a fake
// recording leaves a real meeting behind. On stop, a turn still being spoken is kept like the
// real helper does (#54): its text so far becomes one last transcript.segment, posted before
// /finish and counted in `segments`.
//
// Knobs (env):
//   FAKE_HELPER_PROTOCOL=n        answer hello with another protocol number
//   FAKE_HELPER_CRASH_AFTER_MS=n  exit(3) n ms after start (tests restart/backoff)
//   FAKE_HELPER_CALL_AFTER_MS=n   with detection on, emit call.started after n ms (call.ended 2n)
//   FAKE_HELPER_TOKEN_NEEDED_MS=n while recording, emit token.needed every n ms
//   FAKE_HELPER_LINE_MS=n         a transcript line every n ms (default 4000)
//   FAKE_HELPER_WORD_MS=n         each word of a line arrives as a delta n ms apart (default 60);
//                                 the finished segment follows the last word
//   FAKE_HELPER_BURST_FILE=path   while this file exists, a line every 20 ms (a rate switch a
//                                 test can flip mid-recording to pile up a backlog quickly)
//   FAKE_HELPER_NO_POST=1         don't call the API
//   FAKE_HELPER_MIC=granted|denied|undetermined (default granted)
//   FAKE_HELPER_STOP_UNSAVED=1    record.stop hands back the unposted segments as `unsaved` without
//                                 trying to post them (as if the app was unreachable at stop)
//   FAKE_HELPER_STOP_DELAY_MS=n   record.stop takes n ms (a stop that waits on an outage replay)
//   FAKE_HELPER_SELFTEST_SYSTEM=ok|denied  selftest.run's system side (default ok). A fake second
//                                 lasts 100 ms (fast for tests): the check runs until
//                                 selftest.stop or its `seconds` (default 60) × 100 ms
//   FAKE_HELPER_QUIET_AFTER_MS=n  n ms into a recording the other side goes quiet: no system audio
//                                 and only "me" lines (a meeting that ended; "Still recording?")
//   FAKE_HELPER_START_ERROR=code  record.start fails with that error code
//   FAKE_HELPER_START_DELAY_MS=n  record.start takes n ms; a record.stop meanwhile cancels it (stop
//                                 answers { segments: 0, cancelled: true }, start errors `cancelled`)
// Non-protocol extra, for tests only: {"id", "cmd": "debug.emit", "params": {event...}} echoes an event.

import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);
const PROTOCOL = num("FAKE_HELPER_PROTOCOL", 1);
const LINE_MS = num("FAKE_HELPER_LINE_MS", 4000);
const WORD_MS = num("FAKE_HELPER_WORD_MS", 60);
const POST = env.FAKE_HELPER_NO_POST !== "1";
/** The most segments in one POST: the Worker binds each segment's fields as SQL variables. */
const SEGMENT_BATCH = 50;
const bursting = () => !!env.FAKE_HELPER_BURST_FILE && existsSync(env.FAKE_HELPER_BURST_FILE);

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (...args) => process.stderr.write(`fake-helper: ${args.join(" ")}\n`);
const event = (name, fields = {}) => send({ event: name, ...fields });

const permissions = { mic: env.FAKE_HELPER_MIC ?? "granted", systemAudio: "unknown" };
let rec; // { meetingId, apiBase, token, startedAt, seq, pending: [], timers: [] }
let detectTimers = [];
let starting; // { cancel() } while record.start waits out FAKE_HELPER_START_DELAY_MS
let selfTesting; // { stop() } while selftest.run runs

const LINES = {
  me: ["Thanks everyone for joining.", "Let's go through the launch plan.", "I'll send the notes after this.", "Any blockers on your side?"],
  them: ["Sounds good to me.", "The beta build is ready for review.", "We still need the signing certificate.", "Let's meet again on Thursday."],
};

/** POSTs for recording `r` (the current one by default). */
async function api(path, body, r = rec) {
  if (!POST || !r) return;
  const url = new URL(path, r.apiBase.endsWith("/") ? r.apiBase : `${r.apiBase}/`);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    event("token.needed");
    throw Object.assign(new Error("401"), { code: "unauthorized" });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
}

let flushing = Promise.resolve(true);

/** Posts the pending segments, oldest first, at most SEGMENT_BATCH per request. Resolves true
 * when nothing is left. One flush at a time: a second call waits for the running one. */
function flush() {
  flushing = flushing.then(async () => {
    while (rec && rec.pending.length > 0) {
      const r = rec;
      const batch = r.pending.slice(0, SEGMENT_BATCH);
      try {
        await api(`api/v1/meetings/${encodeURIComponent(r.meetingId)}/segments`, { segments: batch }, r);
        r.pending.splice(0, batch.length);
        r.saved += batch.length;
      } catch (e) {
        event("error", { code: "save_failed", message: String(e.message ?? e), fatal: false });
        return false;
      }
    }
    return true;
  });
  return flushing;
}

function startRecording(params) {
  const startedAt = new Date().toISOString();
  rec = { ...params, token: params.accessToken, startedAt, t0: Date.now(), seq: 0, pending: [], timers: [], n: 0, saved: 0, open: new Map() };
  const quietAfter = num("FAKE_HELPER_QUIET_AFTER_MS", 0);
  const quiet = () => quietAfter > 0 && !!rec && Date.now() - rec.t0 >= quietAfter;
  const state = () => ({ recording: !!rec, meetingId: rec?.meetingId, mode: "realtime", mic: "ok", system: "ok" });
  event("state", state());
  rec.timers.push(
    setInterval(() => event("levels", { mic: Math.random() * 0.6, system: quiet() ? 0 : Math.random() * 0.4 }), 100),
  );
  // A line every LINE_MS, or every 20 ms while the burst file exists.
  const nextLine = () => {
    if (!rec) return;
    const r = rec;
    r.lineTimer = setTimeout(() => {
      if (rec !== r) return;
      line(bursting());
      nextLine();
    }, bursting() ? 20 : LINE_MS);
  };
  const line = (fast) => {
      if (!rec) return;
      if (quiet() && rec.n % 2 === 1) rec.n++;
      const speaker = rec.n % 2 === 0 ? "me" : "them";
      const text = LINES[speaker][Math.floor(rec.n / 2) % LINES[speaker].length];
      const itemId = `item_${rec.n}`;
      const words = text.split(" ");
      const endedMs = Date.now() - rec.t0;
      const segment = { seq: rec.seq++, speaker, text, startedMs: Math.max(0, endedMs - 2500), endedMs };
      rec.n++;
      if (fast) {
        // Burst: the finished line at once, no deltas.
        event("transcript.segment", segment);
        rec.pending.push(segment);
        return;
      }
      // Like the real helper: each delta carries the whole turn so far. The turn stays open (and
      // is kept on stop with its text so far) until its finished segment.
      const r = rec;
      const open = { segment, text: "", timers: [] };
      r.open.set(itemId, open);
      words.forEach((_, i) =>
        open.timers.push(
          setTimeout(() => {
            if (rec !== r) return;
            open.text = words.slice(0, i + 1).join(" ");
            event("transcript.delta", { speaker, text: open.text, itemId });
          }, i * WORD_MS),
        ),
      );
      open.timers.push(
        setTimeout(() => {
          if (rec !== r) return;
          r.open.delete(itemId);
          event("transcript.segment", segment);
          r.pending.push(segment);
        }, words.length * WORD_MS),
      );
  };
  nextLine();
  rec.timers.push(setInterval(() => void flush(), 10_000));
  const tokenEvery = num("FAKE_HELPER_TOKEN_NEEDED_MS", 0);
  if (tokenEvery > 0) rec.timers.push(setInterval(() => event("token.needed"), tokenEvery));
  return { startedAt };
}

/** Stop keeps the turns still being spoken: each becomes a final segment with its text so far
 * (one with no words yet has nothing to keep). */
function closeOpenTurns(r) {
  const turns = [...r.open.values()].sort((a, b) => a.segment.seq - b.segment.seq);
  r.open.clear();
  for (const turn of turns) {
    turn.timers.forEach(clearTimeout);
    if (!turn.text) continue;
    const segment = { ...turn.segment, text: turn.text, endedMs: Math.max(turn.segment.endedMs, Date.now() - r.t0) };
    event("transcript.segment", segment);
    r.pending.push(segment);
  }
}

async function stopRecording() {
  if (!rec) throw { code: "not_recording", message: "Not recording." };
  rec.timers.forEach(clearInterval);
  clearTimeout(rec.lineTimer);
  closeOpenTurns(rec);
  const stopDelay = num("FAKE_HELPER_STOP_DELAY_MS", 0);
  if (stopDelay > 0) await new Promise((r) => setTimeout(r, stopDelay));
  if (env.FAKE_HELPER_STOP_UNSAVED === "1") {
    const unsaved = rec.pending.splice(0);
    const total = rec.seq;
    rec = undefined;
    event("state", { recording: false, mode: "realtime", mic: "ok", system: "ok" });
    return { segments: total - unsaved.length, finished: false, unsaved };
  }
  const drained = await flush();
  const r = rec;
  rec = undefined;
  event("state", { recording: false, mode: "realtime", mic: "ok", system: "ok" });
  if (!drained) {
    // Still unreachable: hand them back (main keeps and replays them, then calls /finish).
    return { segments: r.saved, finished: false, unsaved: r.pending.splice(0) };
  }
  let finished = true;
  try {
    await api(`api/v1/meetings/${encodeURIComponent(r.meetingId)}/finish`, {}, r);
  } catch (e) {
    finished = false;
    event("error", { code: "finish_failed", message: String(e.message ?? e), fatal: false });
  }
  return { segments: r.saved, finished };
}

function setDetection(enabled) {
  detectTimers.forEach(clearTimeout);
  detectTimers = [];
  const after = num("FAKE_HELPER_CALL_AFTER_MS", 0);
  if (enabled && after > 0) {
    const app = { bundleId: "us.zoom.xos", appName: "zoom.us" };
    detectTimers.push(setTimeout(() => event("call.started", app), after), setTimeout(() => event("call.ended", app), after * 2));
  }
}

const handlers = {
  hello: () => ({ protocol: PROTOCOL, version: "0.0.0-fake", macos: "fake" }),
  "permissions.status": () => ({ ...permissions }),
  "permissions.request": (p) => {
    if (p?.kind === "mic" && permissions.mic === "undetermined") permissions.mic = "granted";
    return { ...permissions };
  },
  "selftest.run": async (p) => {
    if (rec || starting) throw { code: "busy", message: "Recording; stop first" };
    if (selfTesting) throw { code: "busy", message: "A self-test is already running" };
    const seconds = p?.seconds ?? 60;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw { code: "bad_params", message: "seconds must be 1–60" };
    const systemOk = env.FAKE_HELPER_SELFTEST_SYSTEM !== "denied";
    const side = (status, peak, device) => ({ status, peak, sampleRate: 48000, device, clipping: false, clippedSamples: 0, dropouts: 0 });
    // Nothing heard at second 0; the mic (and the Mac, unless denied) from second 1.
    const report = (n) => ({
      seconds: n,
      passed: n > 0 && systemOk,
      mic: n > 0 ? side("ok", 0.3, "Fake Microphone") : side("silent", 0, "Fake Microphone"),
      system: n > 0 && systemOk ? side("ok", 0.2, "Fake Speakers") : side("denied", 0, "Fake Speakers"),
    });
    let done = 0;
    event("selftest.progress", report(0));
    const ticker = setInterval(() => event("levels", { mic: 0.3, system: systemOk ? 0.2 : 0 }), 10);
    await new Promise((resolve) => {
      const second = setInterval(() => {
        done += 1;
        event("selftest.progress", report(done));
        if (done >= seconds) finish();
      }, 100);
      const finish = () => (clearInterval(second), resolve());
      selfTesting = { stop: finish };
    });
    clearInterval(ticker);
    selfTesting = undefined;
    return report(done);
  },
  "selftest.stop": () => {
    if (!selfTesting) return { stopped: false };
    selfTesting.stop();
    return { stopped: true };
  },
  "record.start": async (p) => {
    if (selfTesting) throw { code: "busy", message: "A self-test is running" };
    if (rec || starting) throw { code: "already_recording", message: "Already recording." };
    if (!p?.meetingId || !p?.apiBase || !p?.accessToken) throw { code: "bad_params", message: "meetingId, apiBase and accessToken are required." };
    if (permissions.mic === "denied") throw { code: "mic_denied", message: "Microphone access is off for Every App." };
    if (env.FAKE_HELPER_START_ERROR) throw { code: env.FAKE_HELPER_START_ERROR, message: "The fake helper was told to fail." };
    const delay = num("FAKE_HELPER_START_DELAY_MS", 0);
    if (delay > 0) {
      const cancelled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), delay);
        starting = { cancel: () => (clearTimeout(timer), resolve(true)) };
      });
      starting = undefined;
      if (cancelled) throw { code: "cancelled", message: "Stopped before the recording started." };
    }
    return startRecording(p);
  },
  "record.stop": () => {
    if (starting) {
      starting.cancel();
      return { segments: 0, cancelled: true };
    }
    return stopRecording();
  },
  "token.update": (p) => {
    if (rec && p?.accessToken) rec.token = p.accessToken;
    return {};
  },
  "detect.set": (p) => {
    setDetection(!!p?.enabled);
    return {};
  },
  "debug.emit": (p) => {
    send(p);
    return {};
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("not JSON:", line);
    return;
  }
  const handler = handlers[msg.cmd];
  if (!handler) return send({ id: msg.id, ok: false, error: { code: "unknown_command", message: `Unknown command ${msg.cmd}.` } });
  try {
    send({ id: msg.id, ok: true, result: await handler(msg.params) });
  } catch (e) {
    send({ id: msg.id, ok: false, error: { code: e.code ?? "error", message: e.message ?? String(e) } });
  }
});

process.stdin.on("end", async () => {
  if (rec) await stopRecording();
  process.exit(0);
});

const crashAfter = num("FAKE_HELPER_CRASH_AFTER_MS", 0);
if (crashAfter > 0) setTimeout(() => process.exit(3), crashAfter);
log("ready, protocol", PROTOCOL);
