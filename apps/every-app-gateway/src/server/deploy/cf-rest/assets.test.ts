import { describe, expect, it } from "vitest";
import { assetHash, createCloudflareRest } from "./index";
import {
  ACCOUNT_ID,
  API,
  envelope,
  mockFetch,
  noSleep,
} from "./test/mockFetch";

function client(fetch: typeof globalThis.fetch) {
  return createCloudflareRest({
    apiToken: "token",
    accountId: ACCOUNT_ID,
    fetch,
    sleep: noSleep,
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("dispatch assets", () => {
  it("sends the manifest, uploads the requested buckets with the session JWT, and returns the completion JWT", async () => {
    const files = {
      "index.html": { bytes: bytes("<h1>hi</h1>"), contentType: "text/html" },
      "/app.js": { bytes: bytes("console.log(1)") },
    };
    const htmlHash = await assetHash(files["index.html"].bytes, "html");
    const jsHash = await assetHash(files["/app.js"].bytes, "js");
    const { fetch, requests } = mockFetch(
      envelope({ jwt: "session-jwt", buckets: [[htmlHash], [jsHash]] }),
      envelope({}),
      envelope({ jwt: "completion-jwt" }),
    );

    await expect(
      client(fetch).dispatchAssets.upload("apps", "acme--todo", files),
    ).resolves.toBe("completion-jwt");

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${API}/workers/dispatch/namespaces/apps/scripts/acme--todo/assets-upload-session`,
      `POST ${API}/workers/assets/upload?base64=true`,
      `POST ${API}/workers/assets/upload?base64=true`,
    ]);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer token");
    expect(await requests[0]!.json()).toEqual({
      manifest: {
        "/index.html": { hash: htmlHash, size: 11 },
        "/app.js": { hash: jsHash, size: 14 },
      },
    });
    expect(requests[1]!.headers.get("Authorization")).toBe(
      "Bearer session-jwt",
    );
    const part = (await requests[1]!.formData()).get(htmlHash) as File;
    expect(part.type).toBe("text/html");
    expect(atob(await part.text())).toBe("<h1>hi</h1>");
    const jsPart = (await requests[2]!.formData()).get(jsHash) as File;
    expect(jsPart.type).toBe("application/null");
  });

  it("returns the session JWT when Cloudflare already has every file", async () => {
    const { fetch, requests } = mockFetch(
      envelope({ jwt: "session-jwt", buckets: [] }),
    );
    await expect(
      client(fetch).dispatchAssets.upload("apps", "s", {
        "a.txt": { bytes: bytes("a") },
      }),
    ).resolves.toBe("session-jwt");
    expect(requests).toHaveLength(1);
  });

  it("refuses a bucket naming a file it didn't send", async () => {
    const { fetch } = mockFetch(
      envelope({ jwt: "j", buckets: [["0".repeat(32)]] }),
    );
    await expect(
      client(fetch).dispatchAssets.upload("apps", "s", {
        "a.txt": { bytes: bytes("a") },
      }),
    ).rejects.toThrow(/unknown hash/);
  });

  it("hashes the same bytes differently under different extensions", async () => {
    const same = bytes("x");
    const [a, b] = await Promise.all([
      assetHash(same, "css"),
      assetHash(same, "js"),
    ]);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
