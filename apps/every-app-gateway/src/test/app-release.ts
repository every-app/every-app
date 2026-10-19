/**
 * App releases for tests, packed as `everyapp` packs one
 * (everyapp-release.tar.gz: release.json, the Build Output, migrations)
 * by a tiny tar writer and Node's zlib, so the gateway's reader
 * (server/deploy/tar.ts, release.ts) is checked against bytes it didn't
 * make itself.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

interface TarEntry {
  path: string;
  /** Absent for a directory. */
  data?: Uint8Array | string;
  /** The typeflag: `0` file (with data), `5` directory, `2` symlink. */
  type?: string;
  linkname?: string;
}

const encoder = new TextEncoder();

function header(path: string, size: number, type: string, linkname = "") {
  const block = new Uint8Array(512);
  const put = (offset: number, value: string) =>
    block.set(encoder.encode(value), offset);
  put(0, path);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, type);
  put(157, linkname);
  put(257, "ustar\0");
  put(263, "00");
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % 512;
  return rest === 0 ? [data] : [data, new Uint8Array(512 - rest)];
}

/** A tar archive; names over 100 bytes get a pax header, as bsdtar writes. */
export function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    const type = entry.type ?? (entry.data === undefined ? "5" : "0");
    let name = entry.path;
    if (encoder.encode(name).length > 100) {
      const record = (length: number) => `${length} path=${entry.path}\n`;
      let length = record(0).length;
      while (record(length).length !== length) length = record(length).length;
      const pax = encoder.encode(record(length));
      blocks.push(header("PaxHeader", pax.length, "x"), ...padded(pax));
      name = name.slice(-99);
    }
    blocks.push(header(name, data.length, type, entry.linkname));
    if (data.length > 0) blocks.push(...padded(data));
  }
  blocks.push(new Uint8Array(1024));
  const archive = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

export const gzip = (archive: Uint8Array): Uint8Array =>
  new Uint8Array(gzipSync(archive));

/** The CLI's hashFiles over in-memory files. */
function hashFiles(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const digest = createHash("sha256").update(files.get(path)!).digest("hex");
    hash.update(`${path}\0${digest}\n`);
  }
  return hash.digest("hex");
}

const WORKER = ".cloudflare/output/v0/workers/default";

interface ReleaseInput {
  manifest: { id: string } & Record<string, unknown>;
  /** The Build Output's worker.config.json. */
  worker: Record<string, unknown>;
  modules?: Record<string, string>;
  assets?: Record<string, Uint8Array | string>;
  migrations?: Record<string, string>;
  /** More files, beside the release's own. */
  extra?: Record<string, string>;
  /** release.json fields over the computed ones. */
  release?: Record<string, unknown>;
}

/** An app release's files, release.json included. */
export function releaseFiles(input: ReleaseInput): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const add = (path: string, data: Uint8Array | string) =>
    files.set(path, typeof data === "string" ? encoder.encode(data) : data);
  add(`${WORKER}/worker.config.json`, JSON.stringify(input.worker));
  add(".cloudflare/output/v0/config.json", JSON.stringify({ version: 0 }));
  for (const [name, data] of Object.entries(input.modules ?? {})) {
    add(`${WORKER}/bundle/${name}`, data);
  }
  for (const [name, data] of Object.entries(input.assets ?? {})) {
    add(`${WORKER}/assets/${name}`, data);
  }
  for (const [name, data] of Object.entries(input.migrations ?? {})) {
    add(`migrations/${name}`, data);
  }
  for (const [name, data] of Object.entries(input.extra ?? {})) add(name, data);
  const release = {
    schema: 1,
    kind: "app",
    appId: input.manifest.id,
    version: "1.2.3",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    builtAt: "2026-10-19T00:00:00.000Z",
    cfVersion: "1.0.0-beta.14",
    cliVersion: "0.3.0",
    sdkVersion: "0.3.0",
    buildOutputVersion: "v0",
    sha256: hashFiles(files),
    migrations: [],
    minCli: "0.3.0",
    minSdk: "0.3.0",
    manifest: input.manifest,
    ...input.release,
  };
  add("release.json", JSON.stringify(release));
  return files;
}

/** A release's files as everyapp-release.tar.gz, with their directories. */
export function packRelease(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries: TarEntry[] = [{ path: "./" }];
  const dirs = new Set<string>();
  for (const path of [...files.keys()].sort()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.has(dir)) {
        dirs.add(dir);
        entries.push({ path: `./${dir}/` });
      }
    }
    entries.push({ path: `./${path}`, data: files.get(path)! });
  }
  return gzip(tar(entries));
}
