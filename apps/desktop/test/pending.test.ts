import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../src/main/api/client";
import { isPermanentRefusal, PendingUploads, REPLAY_BATCH, type ReplayApi } from "../src/main/pending";
import { feedUrlFrom, sameOrigin, updateRequest } from "../src/main/updateAuth";
import type { TranscriptSegment } from "@shared/protocol";

const segs = (from: number, n: number): TranscriptSegment[] =>
  Array.from({ length: n }, (_, i) => ({ seq: from + i, speaker: i % 2 ? "them" : "me", text: `line ${from + i}`, startedMs: i * 1000, endedMs: i * 1000 + 900 }));

function fakeApi(appUrl = "https://talk.example.com", failAfterPosts = Infinity) {
  const calls: string[] = [];
  let posts = 0;
  const api: ReplayApi = {
    appUrl,
    appendSegments: async (id, s) => {
      if (posts++ >= failAfterPosts) throw new ApiError("network", "offline");
      calls.push(`segments ${id} ${s[0]!.seq}-${s.at(-1)!.seq}`);
    },
    finish: async (id) => {
      calls.push(`finish ${id}`);
    },
  };
  return { api, calls };
}

describe("pending uploads", () => {
  it("keeps leftovers as 0600 files and replays segments in batches, then /finish", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending");
    const p = new PendingUploads(dir);
    p.add("m1", "https://talk.example.com", segs(0, 450), true);
    expect(p.count).toBe(1);
    expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
    const { api, calls } = fakeApi();
    expect(await p.replay(api)).toBe(0);
    expect(REPLAY_BATCH).toBe(50);
    expect(calls).toHaveLength(10); // 9 batches of ≤ 50, then /finish
    expect(calls.slice(0, 2)).toEqual(["segments m1 0-49", "segments m1 50-99"]);
    expect(calls.slice(-2)).toEqual(["segments m1 400-449", "finish m1"]);
  });

  it("merges a second stop's leftovers by seq", () => {
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
    p.add("m1", "https://a", segs(0, 3), false);
    p.add("m1", "https://a", segs(2, 3), true);
    const [m] = p.list();
    expect(m!.segments.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(m!.needsFinish).toBe(true);
  });

  it("stops at a network failure, keeps what didn't land, and resumes later without resending", async () => {
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
    p.add("m1", "https://talk.example.com", segs(0, 300), true);
    const first = fakeApi("https://talk.example.com", 4);
    expect(await p.replay(first.api)).toBe(1);
    expect(first.calls).toEqual(["segments m1 0-49", "segments m1 50-99", "segments m1 100-149", "segments m1 150-199"]);
    expect(p.list()[0]!.segments.map((s) => s.seq)[0]).toBe(200);
    const second = fakeApi();
    expect(await p.replay(second.api)).toBe(0);
    expect(second.calls).toEqual(["segments m1 200-249", "segments m1 250-299", "finish m1"]);
  });

  it("only replays to the app the meeting lives on, drops a deleted meeting and old leftovers", async () => {
    let now = Date.parse("2026-11-02T10:00:00Z");
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"), () => {}, () => now);
    p.add("other", "https://other.example.com", segs(0, 1), false);
    p.add("gone", "https://talk.example.com", segs(0, 1), true);
    const { api } = fakeApi();
    api.appendSegments = async () => {
      throw new ApiError("server", "not found", 404);
    };
    expect(await p.replay(api)).toBe(1);
    expect(p.list().map((m) => m.meetingId)).toEqual(["other"]);
    now += 15 * 24 * 60 * 60_000;
    expect(await p.replay(fakeApi("https://talk.example.com").api)).toBe(0);
  });

  it("keeps time-based seqs (not consecutive, replays in between) in order without duplicates", async () => {
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
    const seg = (startedMs: number, them: boolean, replayed: boolean): TranscriptSegment => ({
      seq: startedMs * 4 + (them ? 2 : 0) + (replayed ? 1 : 0),
      speaker: them ? "them" : "me",
      text: `at ${startedMs}`,
      startedMs,
      endedMs: startedMs + 900,
    });
    p.add("m1", "https://talk.example.com", [seg(12_000, true, false), seg(1_000, false, false)], false);
    p.add("m1", "https://talk.example.com", [seg(5_000, true, true), seg(12_000, true, false)], true);
    expect(p.list()[0]!.segments.map((s) => s.seq)).toEqual([4_000, 20_003, 48_002]);
    const { api, calls } = fakeApi();
    await p.replay(api);
    expect(calls).toEqual(["segments m1 4000-48002", "finish m1"]);
  });

  it("drops a batch the app refuses for good, keeps going, and still finishes", async () => {
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
    p.add("m1", "https://talk.example.com", segs(0, 120), true);
    const { api, calls } = fakeApi();
    const append = api.appendSegments;
    let n = 0;
    api.appendSegments = async (id, s) => {
      if (n++ === 1) throw new ApiError("server", "invalid segment", 422);
      return append(id, s);
    };
    expect(await p.replay(api)).toBe(0);
    expect(calls).toEqual(["segments m1 0-49", "segments m1 100-119", "finish m1"]);
  });

  it("retries later (doesn't drop) on 401, 408, 409, 429 and server errors", async () => {
    for (const status of [408, 409, 429, 500, 503]) {
      const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
      p.add("m1", "https://talk.example.com", segs(0, 10), true);
      const { api } = fakeApi();
      api.appendSegments = async () => {
        throw new ApiError("server", "try later", status);
      };
      expect(await p.replay(api), String(status)).toBe(1);
      expect(p.list()[0]!.segments).toHaveLength(10);
    }
    expect(isPermanentRefusal(ApiError.signedOut())).toBe(false);
    expect(isPermanentRefusal(new ApiError("server", "bad", 400))).toBe(true);
    expect(isPermanentRefusal(new ApiError("server", "gone", 404))).toBe(false);
  });

  it("ignores an empty hand-back", () => {
    const p = new PendingUploads(join(mkdtempSync(join(tmpdir(), "everyapp-pending-")), "pending"));
    p.add("m1", "https://a", [], false);
    expect(p.count).toBe(0);
  });
});

describe("overlapping pending replays", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function pending() {
    const dir = mkdtempSync(join(tmpdir(), "everyapp-pending-overlap-"));
    dirs.push(dir);
    return new PendingUploads(join(dir, "pending"));
  }
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it.each(["append", "finish"] as const)("drains a new meeting signaled during %s, preserving batches and app routing", async (phase) => {
    const p = pending();
    const { api, calls } = fakeApi();
    const entered = deferred();
    const release = deferred();
    const append = api.appendSegments;
    const finish = api.finish;
    api.appendSegments = async (id, segments) => {
      if (id === "A" && phase === "append") { entered.resolve(); await release.promise; }
      await append(id, segments);
    };
    api.finish = async (id) => {
      if (id === "A" && phase === "finish") { entered.resolve(); await release.promise; }
      await finish(id);
    };
    p.add("A", api.appUrl, segs(0, 1), true);
    const first = p.replay(api);
    await entered.promise;
    p.add("B", api.appUrl, segs(10, 60), true);
    p.add("other", "https://other.example.com", segs(0, 1), true);
    const second = p.replay(api);
    release.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(["segments A 0-0", "finish A", "segments B 10-59", "segments B 60-69", "finish B"]);
    expect(p.list().map((m) => m.meetingId)).toEqual(["other"]);
  });

  it.each(["append", "finish"] as const)("stops on a failed %s despite an overlapping wakeup and can retry later", async (phase) => {
    const p = pending();
    const { api, calls } = fakeApi();
    const entered = deferred();
    const release = deferred();
    let attempts = 0;
    const fail = async () => {
      attempts++;
      entered.resolve();
      await release.promise;
      throw new ApiError("network", "offline");
    };
    if (phase === "append") api.appendSegments = fail;
    else api.finish = fail;
    p.add("A", api.appUrl, segs(0, 1), true);
    const first = p.replay(api);
    await entered.promise;
    p.add("B", api.appUrl, segs(10, 1), true);
    const second = p.replay(api);
    release.resolve();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
    expect(calls).toEqual(phase === "append" ? [] : ["segments A 0-0"]);
    expect(p.list().map(({ meetingId, segments, needsFinish }) => ({ meetingId, segments, needsFinish }))).toEqual([
      { meetingId: "A", segments: phase === "append" ? segs(0, 1) : [], needsFinish: true },
      { meetingId: "B", segments: segs(10, 1), needsFinish: true },
    ]);
    const retry = fakeApi();
    expect(await p.replay(retry.api)).toBe(0);
    expect(retry.calls).toEqual([...(phase === "append" ? ["segments A 0-0"] : []), "finish A", "segments B 10-10", "finish B"]);
  });

  it.each(["B", "C"] as const)("hands the next pass to the latest requested app %s", async (latest) => {
    const p = pending();
    const apis = {
      A: fakeApi("https://a.example.com"),
      B: fakeApi("https://b.example.com"),
      C: fakeApi("https://c.example.com"),
    };
    const entered = deferred();
    const release = deferred();
    const append = apis.A.api.appendSegments;
    apis.A.api.appendSegments = async (id, segments) => {
      entered.resolve();
      await release.promise;
      await append(id, segments);
    };
    for (const [id, { api }] of Object.entries(apis)) p.add(id, api.appUrl, segs(0, 1), true);
    const first = p.replay(apis.A.api);
    await entered.promise;
    const second = p.replay(apis.B.api);
    const third = latest === "C" ? p.replay(apis.C.api) : Promise.resolve();
    release.resolve();
    await Promise.all([first, second, third]);
    for (const [id, { calls }] of Object.entries(apis)) {
      expect(calls, id).toEqual(id === "A" || id === latest ? [`segments ${id} 0-0`, `finish ${id}`] : []);
    }
    const retained = latest === "B" ? "C" : "B";
    expect(p.list().map(({ meetingId, appUrl, segments, needsFinish }) => ({ meetingId, appUrl, segments, needsFinish }))).toEqual([
      { meetingId: retained, appUrl: apis[retained].api.appUrl, segments: segs(0, 1), needsFinish: true },
    ]);
  });

  it("retains wakeups received during a follow-up pass", async () => {
    const p = pending();
    const { api, calls } = fakeApi();
    const append = api.appendSegments;
    api.appendSegments = async (id, segments) => {
      await append(id, segments);
      if (id === "A" || id === "B") {
        p.add(id === "A" ? "B" : "C", api.appUrl, segs(0, 1), true);
        await p.replay(api);
      }
    };
    p.add("A", api.appUrl, segs(0, 1), true);
    expect(await p.replay(api)).toBe(0);
    expect(calls).toEqual(["segments A 0-0", "finish A", "segments B 0-0", "finish B", "segments C 0-0", "finish C"]);
  });
});

describe("update feed auth", () => {
  it("reads the feed URL from app-update.yml", () => {
    expect(feedUrlFrom("provider: generic\nurl: https://talk.example.com/api/v1/updates/mac/\nupdaterCacheDirName: everyapp-desktop-updater\n")).toBe("https://talk.example.com/api/v1/updates/mac/");
    expect(feedUrlFrom("provider: generic\nurl: 'https://x.r2.dev/feed'\n")).toBe("https://x.r2.dev/feed");
    expect(feedUrlFrom("provider: github\n")).toBeUndefined();
  });

  it("sends the bearer only to the signed-in app's own https origin", () => {
    const feed = "https://talk.example.com/api/v1/updates/mac/";
    expect(updateRequest(feed, "https://talk.example.com", "tok")).toEqual({ skip: false, headers: { Authorization: "Bearer tok" } });
    expect(updateRequest(feed, "https://talk.example.com", undefined)).toEqual({ skip: true });
    expect(updateRequest("https://bucket.r2.dev/feed", "https://talk.example.com", "tok")).toEqual({ skip: false, headers: null });
    expect(updateRequest(feed, "https://talk.example.com.evil.io", "tok")).toEqual({ skip: false, headers: null });
    expect(updateRequest(feed, undefined, "tok")).toEqual({ skip: false, headers: null });
    expect(sameOrigin("http://talk.localhost:8787/u/", "http://talk.localhost:8787")).toBe(false); // https only
  });
});
