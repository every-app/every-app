/**
 * An app release on GitHub, as `everyapp` packs it: the repository's
 * latest release carries `everyapp-release.tar.gz`, holding release.json,
 * the tenant-neutral Build Output (.cloudflare/output/v0, built with the
 * hosted sentinel inputs) and the app's migrations. The gateway downloads
 * it with no credentials, reads it in memory (./tar.ts), checks its
 * SHA-256 the way the CLI does (packages/cli/src/lib/gateway/release.ts
 * `hashFiles`), and makes of it the DeployBundle a multipart upload makes
 * (./bundle.ts), so the pipeline can't tell the two apart.
 */
import {
  bundleModuleType,
  HOSTED_DEPLOY_PROTOCOL,
} from "@every-app/perimeter/manifest";
import type { DeployJobSource } from "@/server/repositories/DeployJobRepository";
import { parseStamp, type DeployBundle } from "./bundle";
import { bundleRefused, DeployError } from "./errors";
import { readTar, TarError } from "./tar";

const APP_RELEASE_ASSET = "everyapp-release.tar.gz";

/** Compressed, and again unpacked: a gzip bomb stops here too. */
const MAX_RELEASE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_REDIRECTS = 5;
const BUILD_OUTPUT = ".cloudflare/output/v0";
const WORKERS = `${BUILD_OUTPUT}/workers/`;
const DEFAULT_WORKER = `${WORKERS}default/`;
/** All a release holds at its top level, as `openRelease` in the CLI. */
const RELEASE_ENTRIES = new Set([".cloudflare", "migrations", "release.json"]);

interface AppRelease {
  appId: string;
  bundle: DeployBundle;
  source: DeployJobSource;
}

interface ReleaseManifest {
  appId: string;
  version: string;
  gitSha: string;
  sdkVersion: string | null;
  cliVersion: string;
  sha256: string;
  manifest: Record<string, unknown>;
}

const invalid = (message: string) =>
  new DeployError("RELEASE_INVALID", 422, message);

/** `https://github.com/<owner>/<repo>`, or INVALID_REPO_URL. */
export function parseRepoUrl(raw: unknown): {
  owner: string;
  repo: string;
  repoUrl: string;
} {
  const refused = () =>
    new DeployError(
      "INVALID_REPO_URL",
      400,
      "Paste a GitHub repository URL: https://github.com/<owner>/<repo>.",
    );
  if (typeof raw !== "string") throw refused();
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
      raw.trim(),
    );
  if (!match || match[2] === "." || match[2] === "..") throw refused();
  const [, owner, repo] = match as unknown as [string, string, string];
  return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}` };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The CLI's `hashFiles` over the archive's files: each one's path, NUL,
 * the SHA-256 of its contents in hex and a newline, in path order; the
 * SHA-256 of all of that.
 */
async function hashReleaseFiles(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<string> {
  const lines: string[] = [];
  for (const path of [...files.keys()].sort()) {
    if (path === "release.json") continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      files.get(path) as Uint8Array<ArrayBuffer>,
    );
    lines.push(`${path}\0${hex(digest)}\n`);
  }
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(lines.join("")),
    ),
  );
}

function parseReleaseJson(bytes: Uint8Array | undefined): ReleaseManifest {
  if (!bytes) throw invalid("The release has no release.json.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    throw invalid("The release's release.json isn't JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("The release's release.json isn't an object.");
  }
  const unsupported = (message: string) =>
    new DeployError("RELEASE_UNSUPPORTED", 422, message);
  if (raw["schema"] !== 1) {
    throw unsupported(
      `The release's schema is ${String(raw["schema"])}; this gateway reads schema 1.`,
    );
  }
  if (raw["kind"] !== "app") {
    throw unsupported(
      "The release isn't an app release (release.json kind isn't \"app\").",
    );
  }
  if (raw["buildOutputVersion"] !== "v0") {
    throw unsupported(
      `The release's Build Output is ${String(raw["buildOutputVersion"])}; this gateway deploys v0.`,
    );
  }
  for (const key of ["appId", "version", "gitSha", "cliVersion"] as const) {
    if (typeof raw[key] !== "string" || !raw[key]) {
      throw invalid(`The release's release.json has no ${key}.`);
    }
  }
  if (raw["sdkVersion"] !== null && typeof raw["sdkVersion"] !== "string") {
    throw invalid("The release's sdkVersion must be a string or null.");
  }
  if (
    typeof raw["sha256"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw["sha256"])
  ) {
    throw invalid("The release's release.json has no sha256.");
  }
  const manifest = raw["manifest"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalid("The release's release.json has no manifest.");
  }
  return raw as unknown as ReleaseManifest;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Check an unpacked release and make its DeployBundle: what
 * `packageHostedBundle` (packages/cli/src/lib/app/hostedBundle.ts) uploads
 * from the same Build Output.
 */
export async function bundleFromRelease(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<{ release: ReleaseManifest; bundle: DeployBundle }> {
  const unexpected = new Set(
    [...files.keys()]
      .map((path) => path.split("/")[0]!)
      .filter((entry) => !RELEASE_ENTRIES.has(entry)),
  );
  if (unexpected.size > 0) {
    throw invalid(
      `The release holds more than an app release: ${[...unexpected].join(", ")}.`,
    );
  }
  const release = parseReleaseJson(files.get("release.json"));
  const actual = await hashReleaseFiles(files);
  if (actual !== release.sha256) {
    throw new DeployError(
      "RELEASE_CORRUPT",
      422,
      `Release ${release.version} doesn't match its SHA-256 (expected ${release.sha256}, got ${actual}).`,
    );
  }

  const helpers = new Set(
    [...files.keys()]
      .filter((path) => path.startsWith(WORKERS))
      .map((path) => path.slice(WORKERS.length).split("/")[0]!)
      .filter((worker) => worker !== "default"),
  );
  if (helpers.size > 0) {
    throw bundleRefused([
      `its Build Output has helper Workers (${[...helpers].join(", ")}), which third-party apps can't have`,
    ]);
  }
  const configBytes = files.get(`${DEFAULT_WORKER}worker.config.json`);
  if (!configBytes) {
    throw invalid(
      `The release has no ${DEFAULT_WORKER}worker.config.json: it isn't a Build Output.`,
    );
  }
  let worker: unknown;
  try {
    worker = JSON.parse(new TextDecoder().decode(configBytes));
  } catch {
    throw invalid("The release's worker.config.json isn't JSON.");
  }
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
    throw invalid("The release's worker.config.json isn't a Worker config.");
  }
  const declared =
    (worker as { manifest?: { modules?: Record<string, { type?: string }> } })
      .manifest?.modules ?? {};

  const bundle: DeployBundle = {
    manifest: release.manifest,
    stamp: parseStamp({
      protocol: HOSTED_DEPLOY_PROTOCOL,
      sdkVersion: release.sdkVersion,
      cliVersion: release.cliVersion,
    }),
    worker: worker as Record<string, unknown>,
    modules: new Map(),
    assets: new Map(),
    migrations: [],
  };
  const bundleDir = `${DEFAULT_WORKER}bundle/`;
  const assetsDir = `${DEFAULT_WORKER}assets/`;
  for (const [path, content] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (path.startsWith(bundleDir)) {
      const name = path.slice(bundleDir.length);
      // What cf wouldn't upload as a module, the CLI wouldn't send either.
      if (bundleModuleType(name, declared[name]?.type)) {
        bundle.modules.set(name, content);
      }
    } else if (path.startsWith(assetsDir)) {
      bundle.assets.set(`/${path.slice(assetsDir.length)}`, content);
    } else if (path.startsWith("migrations/")) {
      const name = path.slice("migrations/".length);
      // `<name>.sql`, or drizzle-kit's newer `<tag>/migration.sql`.
      if (/^[^/]+\.sql$/.test(name) || /^[^/]+\/migration\.sql$/.test(name)) {
        bundle.migrations.push({
          name,
          sql: new TextDecoder().decode(content),
        });
      }
    }
  }
  bundle.migrations.sort(byName);
  return { release, bundle };
}

/** Every chunk counted; past `max` bytes the stream errors. */
function capped(
  max: number,
  what: string,
): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > max) {
        controller.error(tooLarge(what));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

const tooLarge = (what: string) =>
  new DeployError(
    "RELEASE_TOO_LARGE",
    413,
    `The release is larger than ${MAX_RELEASE_BYTES / 1024 / 1024} MB ${what}; the gateway installs smaller ones only.`,
  );

/** The unpacked tar of a gzip stream, both sides bounded. */
async function gunzip(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body
    .pipeThrough(capped(MAX_RELEASE_BYTES, "compressed"))
    .pipeThrough(
      new DecompressionStream("gzip") as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    )
    .pipeThrough(capped(MAX_RELEASE_BYTES, "unpacked"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw invalid(
      `The release isn't a gzip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

const fetchFailed = (message: string) =>
  new DeployError("RELEASE_FETCH_FAILED", 502, message);

/**
 * Download the repository's latest everyapp release: GitHub redirects the
 * `latest/download` URL to the release's tag and then to its storage, each
 * hop followed here (https only, a few at most) so the tag is known. No
 * credentials are sent: only public releases install.
 */
async function download(
  owner: string,
  repo: string,
): Promise<{ body: ReadableStream<Uint8Array>; tag: string | null }> {
  const noRelease = () =>
    new DeployError(
      "NO_RELEASE",
      404,
      `${owner}/${repo} publishes no everyapp release (its latest GitHub release has no ${APP_RELEASE_ASSET}). Clone it and run \`pnpm everyapp deploy\` with a deploy key (Admin → Tokens → Deploy key).`,
    );
  let url = new URL(
    `https://github.com/${owner}/${repo}/releases/latest/download/${APP_RELEASE_ASSET}`,
  );
  let tag: string | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual" });
    } catch (error) {
      throw fetchFailed(
        `GitHub couldn't be reached: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw fetchFailed("GitHub redirected nowhere.");
      url = new URL(location, url);
      if (url.protocol !== "https:") {
        throw fetchFailed("GitHub redirected the download off https.");
      }
      const named =
        url.hostname === "github.com"
          ? /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/[^/]+$/.exec(
              url.pathname,
            )
          : null;
      if (named && tag === null) tag = decodeURIComponent(named[1]!);
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw noRelease();
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw fetchFailed(
        `GitHub answered ${response.status} for ${owner}/${repo}'s release.`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_RELEASE_BYTES) {
      await response.body.cancel();
      throw tooLarge("compressed");
    }
    return { body: response.body, tag };
  }
  throw fetchFailed("GitHub redirected the download too many times.");
}

/** The repository's latest release, checked and ready to deploy. */
export async function fetchAppRelease(repo: {
  owner: string;
  repo: string;
  repoUrl: string;
}): Promise<AppRelease> {
  const { body, tag } = await download(repo.owner, repo.repo);
  let files: Map<string, Uint8Array>;
  try {
    files = readTar(await gunzip(body), { maxFiles: MAX_FILES });
  } catch (error) {
    if (error instanceof TarError) {
      throw invalid(`The release isn't a readable archive: ${error.message}.`);
    }
    throw error;
  }
  const { release, bundle } = await bundleFromRelease(files);
  return {
    appId: release.appId,
    bundle,
    source: {
      repoUrl: repo.repoUrl,
      tag,
      version: release.version,
      gitSha: release.gitSha,
    },
  };
}
