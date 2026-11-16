import { json, type CloudflareTransport } from "./client";

export interface AssetFile {
  bytes: Uint8Array;
  /**
   * Served as this. Left out, it is the type of the path's extension
   * ({@link assetContentType}); an unknown one goes up as
   * "application/null", as wrangler sends it.
   */
  contentType?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  map: "application/json",
};

/**
 * The type an asset is served as, from its extension. Cloudflare serves an
 * asset with the type it was uploaded with, and the perimeter sends
 * `X-Content-Type-Options: nosniff`, so a stylesheet or module script
 * uploaded without one is refused by the browser.
 */
function assetContentType(path: string): string | undefined {
  return CONTENT_TYPES[extension(path)];
}

interface UploadSession {
  jwt?: string;
  buckets?: string[][];
}

/**
 * Static assets for a script in a dispatch namespace, over the upload
 * session protocol: send the manifest, upload only the files Cloudflare
 * asks for (in its buckets, authorized by the session JWT), then put the
 * completion JWT in the script's `metadata.assets.jwt`.
 */
export function dispatchAssets(transport: CloudflareTransport) {
  return scriptAssets(transport);
}

/** Static assets for an account Worker, using the same upload protocol. */
export function workerAssets(transport: CloudflareTransport) {
  const assets = scriptAssets(transport);
  return {
    upload: (script: string, files: Record<string, AssetFile>) =>
      assets.upload(null, script, files),
  };
}

function scriptAssets(transport: CloudflareTransport) {
  return {
    /** Upload `files` (by path) and return the completion JWT. */
    upload: async (
      namespace: string | null,
      script: string,
      files: Record<string, AssetFile>,
    ): Promise<string> => {
      const context = `Upload assets of ${namespace === null ? "Worker " : `dispatch script ${namespace}/`}${script}`;
      const entries = await Promise.all(
        Object.entries(files).map(async ([path, file]) => {
          const type =
            file.contentType ?? assetContentType(path) ?? "application/null";
          return {
            path: normalizeAssetPath(path),
            file,
            type,
            hash: await assetHash(file.bytes, type),
          };
        }),
      );
      const manifest = Object.fromEntries(
        entries.map((entry) => [
          entry.path,
          { hash: entry.hash, size: entry.file.bytes.byteLength },
        ]),
      );
      const session = await transport.request<UploadSession>(
        transport.accountPath(
          "workers",
          ...(namespace === null ? [] : ["dispatch", "namespaces", namespace]),
          "scripts",
          script,
          "assets-upload-session",
        ),
        json("POST", { manifest }),
        { context, envelopeOptional: namespace === null },
      );
      if (!session.jwt)
        throw new Error(`${context}: the session returned no JWT`);
      const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
      let completion = session.jwt;
      for (const bucket of session.buckets ?? []) {
        const form = new FormData();
        for (const hash of bucket) {
          const entry = byHash.get(hash);
          if (!entry)
            throw new Error(
              `${context}: Cloudflare asked for unknown hash ${hash}`,
            );
          form.set(
            hash,
            new File([base64(entry.file.bytes)], hash, { type: entry.type }),
          );
        }
        const result = await transport.request<{ jwt?: string } | null>(
          `${transport.accountPath("workers", "assets", "upload")}?base64=true`,
          { method: "POST", body: form },
          { context, authorization: session.jwt },
        );
        completion = result?.jwt ?? completion;
      }
      return completion;
    },
  };
}

/**
 * SHA-256 over the content and the type it is served as, truncated to the
 * 32 hex characters the API expects. A blob keeps the type it was first
 * uploaded with, and Cloudflare asks only for hashes it doesn't hold, so
 * the type is mixed in: the same bytes under another type are another
 * blob, and a file once uploaded untyped goes up again with its type.
 * Hashes only identify files within a session, so differing from
 * wrangler's BLAKE3 costs nothing but cross-client dedup.
 */
export async function assetHash(
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const suffix = new TextEncoder().encode(`\0${contentType}`);
  const combined = new Uint8Array(bytes.byteLength + suffix.byteLength);
  combined.set(bytes);
  combined.set(suffix, bytes.byteLength);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", combined),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function normalizeAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
