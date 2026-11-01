import { json, type CloudflareTransport } from "./client";

export interface AssetFile {
  bytes: Uint8Array;
  /** Served as this; unknown types go up as "application/null", as wrangler sends them. */
  contentType?: string;
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
        Object.entries(files).map(async ([path, file]) => ({
          path: normalizeAssetPath(path),
          file,
          hash: await assetHash(file.bytes, extension(path)),
        })),
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
      const byHash = new Map(entries.map((entry) => [entry.hash, entry.file]));
      let completion = session.jwt;
      for (const bucket of session.buckets ?? []) {
        const form = new FormData();
        for (const hash of bucket) {
          const file = byHash.get(hash);
          if (!file)
            throw new Error(
              `${context}: Cloudflare asked for unknown hash ${hash}`,
            );
          form.set(
            hash,
            new File([base64(file.bytes)], hash, {
              type: file.contentType ?? "application/null",
            }),
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
 * SHA-256 over the content and its extension, truncated to the 32 hex
 * characters the API expects. The extension is mixed in so identical bytes
 * under two extensions don't share a blob (a blob has one content type).
 * Hashes only identify files within a session, so differing from
 * wrangler's BLAKE3 costs nothing but cross-client dedup.
 */
export async function assetHash(
  bytes: Uint8Array,
  extensionName = "",
): Promise<string> {
  const suffix = new TextEncoder().encode(`\0${extensionName}`);
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
