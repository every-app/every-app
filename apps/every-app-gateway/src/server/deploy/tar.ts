/**
 * Just enough of tar to read an app release (./release.ts) in a Worker:
 * ustar headers, pax (`x`) and GNU (`L`) long names, directories and
 * regular files. The archive is untrusted, so anything else (links,
 * devices, a path outside the archive, a header whose checksum is wrong, a
 * file listed twice) refuses the whole archive rather than being skipped.
 */

const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const decoder = new TextDecoder();

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  // Base-256 sizes (the high bit set) are for files of 8 GB and up.
  if ((block[offset]! & 0x80) !== 0) {
    throw new TarError("a tar header uses a base-256 number");
  }
  const raw = text(block, offset, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new TarError("a tar header is corrupt");
  return raw ? Number.parseInt(raw, 8) : 0;
}

function checksumMatches(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field counts as eight spaces.
    sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  }
  return sum === octal(block, 148, 8);
}

/** pax extended header records: `<length> <key>=<value>\n`. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new TarError("a pax header is corrupt");
    const length = Number(decoder.decode(data.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= space - offset) {
      throw new TarError("a pax header is corrupt");
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length));
    const equals = record.indexOf("=");
    if (equals === -1 || !record.endsWith("\n")) {
      throw new TarError("a pax header is corrupt");
    }
    records.set(record.slice(0, equals), record.slice(equals + 1, -1));
    offset += length;
  }
  return records;
}

// No empty segments, no `.` or `..`, no backslashes or control characters.
const SEGMENT = /^(?!\.\.?$)[^/\\\u0000-\u001f]+$/;

/** The entry's path relative to the archive, `./` and a trailing `/` dropped. */
function entryPath(raw: string): string | null {
  let path = raw;
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "" || path === ".") return null;
  if (!path.split("/").every((segment) => SEGMENT.test(segment))) {
    throw new TarError(`"${raw}" isn't a relative path inside the archive`);
  }
  return path;
}

interface TarLimits {
  maxFiles: number;
}

/** The archive's regular files by path; directories are implied. */
export function readTar(
  archive: Uint8Array,
  limits: TarLimits,
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  // What a pax or GNU header says of the entry after it.
  let nextPath: string | null = null;
  let nextSize: number | null = null;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return files;
    if (!checksumMatches(header)) {
      throw new TarError("a tar header's checksum doesn't match");
    }
    const type = String.fromCharCode(header[156]!);
    const size = nextSize ?? octal(header, 124, 12);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > archive.length) throw new TarError("the archive is truncated");
    const data = archive.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const records = paxRecords(data);
      nextPath = records.get("path") ?? nextPath;
      const paxSize = records.get("size");
      if (paxSize !== undefined) {
        if (!/^\d+$/.test(paxSize)) throw new TarError("a pax size is corrupt");
        nextSize = Number(paxSize);
      }
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextPath = text(data, 0, data.length);
      continue;
    }
    let raw = nextPath;
    if (raw === null) {
      const name = text(header, 0, 100);
      const prefix =
        text(header, 257, 5) === "ustar" ? text(header, 345, 155) : "";
      raw = prefix ? `${prefix}/${name}` : name;
    }
    nextPath = null;
    nextSize = null;
    if (raw.startsWith("/")) {
      throw new TarError(`"${raw}" is an absolute path`);
    }
    const path = entryPath(raw);
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new TarError(
        type === "1" || type === "2"
          ? `"${raw}" is a link, which a release can't hold`
          : `"${raw}" isn't a regular file or a directory`,
      );
    }
    if (path === null) throw new TarError("a file in the archive has no name");
    if (files.has(path))
      throw new TarError(`"${path}" is in the archive twice`);
    files.set(path, data);
    if (files.size > limits.maxFiles) {
      throw new TarError(
        `the archive holds more than ${limits.maxFiles} files`,
      );
    }
  }
  // The end-of-archive blocks are optional to a reader; a file cut short
  // was refused above.
  if (offset < archive.length) throw new TarError("the archive is truncated");
  return files;
}
