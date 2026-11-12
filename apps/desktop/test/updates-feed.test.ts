import { describe, expect, it } from "vitest";
import { handle, keyFor, parseRange, type R2Bucket } from "../updates/index";

const uploaded = new Date("2026-11-12T00:00:00Z");

/** An in-memory bucket. */
function bucket(files: Record<string, string>): R2Bucket {
  const meta = (key: string) => ({ size: files[key]!.length, httpEtag: `"${key}"`, uploaded });
  return {
    async head(key) {
      return key in files ? meta(key) : null;
    },
    async get(key, options) {
      if (!(key in files)) return null;
      const data = files[key]!;
      const part = options ? data.slice(options.range.offset, options.range.offset + options.range.length) : data;
      return { ...meta(key), body: new Response(part).body! };
    },
  };
}

const env = {
  UPDATES: bucket({
    "mac/latest-mac.yml": "version: 0.1.1\n",
    "mac/EveryApp-0.1.1-universal-mac.zip": "0123456789",
  }),
};
const get = (path: string, init?: RequestInit) => handle(new Request(`https://updates.everyapp.com${path}`, init), env);

describe("update feed", () => {
  it("serves only the manifest and EveryApp release files on a known channel", () => {
    expect(keyFor("/mac/latest-mac.yml")).toBe("mac/latest-mac.yml");
    for (const name of ["EveryApp-0.1.1-universal-mac.zip", "EveryApp-0.1.1-universal-mac.zip.blockmap", "EveryApp-0.1.1-universal.dmg", "EveryApp-1.2.3-beta.1-universal-mac.zip"]) {
      expect(keyFor(`/mac/${name}`)).toBe(`mac/${name}`);
    }
    for (const path of ["/mac/Talk-0.1.1-universal-mac.zip", "/mac/EveryApp-0.1.1-../x.zip", "/mac/EveryApp-0.1.1.exe", "/mac/../secret", "/mac/a/latest-mac.yml", "/other/latest-mac.yml", "/latest-mac.yml"]) {
      expect(keyFor(path)).toBeNull();
    }
  });

  it("revalidates the manifest and caches release files for a year", async () => {
    const yml = await get("/mac/latest-mac.yml");
    expect(yml.status).toBe(200);
    expect(yml.headers.get("cache-control")).toBe("public, no-cache");
    expect(yml.headers.get("content-type")).toContain("text/yaml");
    expect(await yml.text()).toBe("version: 0.1.1\n");

    const zip = await get("/mac/EveryApp-0.1.1-universal-mac.zip");
    expect(zip.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(zip.headers.get("content-length")).toBe("10");
    expect(zip.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers Range requests with 206, and 416 past the end", async () => {
    const part = await get("/mac/EveryApp-0.1.1-universal-mac.zip", { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const tail = await get("/mac/EveryApp-0.1.1-universal-mac.zip", { headers: { range: "bytes=-3" } });
    expect(tail.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await tail.text()).toBe("789");

    const past = await get("/mac/EveryApp-0.1.1-universal-mac.zip", { headers: { range: "bytes=50-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");
  });

  it("parses one bytes= range; ignores malformed ones", () => {
    expect(parseRange("bytes=0-", 10)).toEqual([0, 9]);
    expect(parseRange("bytes=5-100", 10)).toEqual([5, 9]);
    expect(parseRange("bytes=-20", 10)).toEqual([0, 9]);
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    for (const h of ["bytes=-", "bytes=5-2", "bytes=0-1,4-5", "items=0-1"]) expect(parseRange(h, 10)).toBeNull();
  });

  it("HEAD gives the size without a body; missing files, other paths and methods are refused", async () => {
    const head = await get("/mac/EveryApp-0.1.1-universal-mac.zip", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");

    expect((await get("/mac/EveryApp-9.9.9-universal-mac.zip")).status).toBe(404);
    expect((await get("/mac/Talk-0.1.1-universal-mac.zip")).status).toBe(404);
    expect((await get("/mac/latest-mac.yml", { method: "PUT", body: "x" })).status).toBe(405);
    expect((await get("/")).status).toBe(302);
  });
});
