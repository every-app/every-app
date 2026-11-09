import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
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
