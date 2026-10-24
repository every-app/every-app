import { describe, expect, it } from "vitest";
import {
  cacheFingerprintedAsset,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  isFingerprintedAssetPath,
} from "./assetCache";

const DEFAULT = "public, max-age=0, must-revalidate";

function asset(init: ResponseInit & { body?: string } = {}): Response {
  const { body = "console.log(1)", ...rest } = init;
  // A 304 takes no body.
  return new Response(rest.status === 304 ? null : body, {
    status: 200,
    ...rest,
    headers: {
      "content-type": "text/javascript",
      "cache-control": DEFAULT,
      etag: '"abc"',
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

describe("isFingerprintedAssetPath", () => {
  it("matches Vite's /assets/<name>-<hash>.<ext> names, dots in the name included", () => {
    for (const path of [
      "/assets/index-XCAqY2Hj.js",
      "/assets/chunk-OBN6QJEY-ZWmSFTUV.js",
      "/assets/_locale.app.sites._siteSlug.events-DV6xoWT6.js",
      "/assets/app-Dvx-ZGoF.css",
      "/assets/inter-latin-B2xhLi22.woff2",
      "/assets/logo-aB_c-12Z.svg",
      "/assets/chunk-ZWmSFTUV.js",
      "/assets/badge-BNhRgbGO.js",
      "/assets/worker-C7vatgpl.js.map",
    ]) {
      expect(path, path).toSatisfy(isFingerprintedAssetPath);
    }
  });

  it("matches nothing else", () => {
    for (const path of [
      "/",
      "/assets/",
      "/assets/logo.svg",
      "/assets/index-XCAqY2H.js",
      "/assets/index-XCAqY2Hj9.js",
      "/assets/index-XCAqY2Hj",
      "/assets/index-XCAqY2Hj.html",
      "/assets/index-XCAqY2Hj.js/",
      "/assets/index-XCAqY2Hj.map",
      "/assets/sw-register.js",
      "/assets/icon-maskable.png",
      "/assets/LOGO-MASKABLE.png",
      "/assets/sub/index-XCAqY2Hj.js",
      "/static/index-XCAqY2Hj.js",
      "/api/images/companies-abcdefgh.png",
      "/everyapp-icon.svg",
    ]) {
      expect(path, path).not.toSatisfy(isFingerprintedAssetPath);
    }
  });
});

describe("cacheFingerprintedAsset", () => {
  it("marks a fingerprinted asset the app left to the asset server's default immutable", async () => {
    const cached = cacheFingerprintedAsset(
      "GET",
      "/assets/index-XCAqY2Hj.js",
      asset(),
    );
    expect(cached.headers.get("cache-control")).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL,
    );
    expect(cached.headers.get("etag")).toBe('"abc"');
    expect(cached.headers.get("content-type")).toBe("text/javascript");
    expect(await cached.text()).toBe("console.log(1)");
  });

  it("takes the default in any spelling, on a 304 too", () => {
    for (const value of [
      "Public, Max-Age=0, Must-Revalidate",
      "public,max-age=0,must-revalidate",
    ]) {
      const cached = cacheFingerprintedAsset(
        "HEAD",
        "/assets/index-XCAqY2Hj.js",
        asset({ headers: { "cache-control": value } }),
      );
      expect(cached.headers.get("cache-control")).toBe(
        IMMUTABLE_ASSET_CACHE_CONTROL,
      );
    }
    // A chunk the browser cached before this rule asks once more and is
    // told, with the 304, to stop asking.
    const revalidated = cacheFingerprintedAsset(
      "GET",
      "/assets/app-Dvx-ZGoF.css",
      asset({ status: 304, headers: { "content-type": "text/css" } }),
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL,
    );
  });

  it("keeps caching an app chose itself, and a response that named none", () => {
    for (const value of ["no-store", "public, max-age=60", "private"]) {
      const response = asset({ headers: { "cache-control": value } });
      const result = cacheFingerprintedAsset(
        "GET",
        "/assets/index-XCAqY2Hj.js",
        response,
      );
      expect(result).toBe(response);
      expect(result.headers.get("cache-control")).toBe(value);
    }
    // An app's own route under /assets/ that says nothing about caching
    // is not the asset server's, and may change under its name.
    const dynamic = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    expect(
      cacheFingerprintedAsset("GET", "/assets/config-v2026102a.json", dynamic),
    ).toBe(dynamic);
    expect(dynamic.headers.get("cache-control")).toBeNull();
  });

  it("touches no other response", () => {
    const untouched = [
      ["POST", "/assets/index-XCAqY2Hj.js", asset()],
      ["GET", "/assets/index-XCAqY2Hj.js", asset({ status: 404 })],
      ["GET", "/assets/logo.svg", asset()],
      ["GET", "/index-XCAqY2Hj.js", asset()],
      [
        "GET",
        "/assets/page-XCAqY2Hj.js",
        asset({ headers: { "content-type": "text/html; charset=utf-8" } }),
      ],
    ] as const;
    for (const [method, path, response] of untouched) {
      const result = cacheFingerprintedAsset(method, path, response);
      expect(result, `${method} ${path}`).toBe(response);
    }
  });
});
