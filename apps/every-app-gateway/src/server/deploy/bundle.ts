/**
 * A deploy upload, as `everyapp deploy --gateway` sends it: one multipart
 * body (HOSTED_DEPLOY_PARTS in @every-app/perimeter/manifest) holding the
 * evaluated manifest, the CLI's stamp, the Build Output's
 * worker.config.json, and the bundle's modules, static assets and the
 * app's migrations as files named by path. Everything here is untrusted:
 * parsed, size-checked and path-checked, never interpreted (that is
 * ./metadata.ts's work).
 */
import {
  HOSTED_DEPLOY_PARTS,
  MIN_HOSTED_DEPLOY_PROTOCOL,
} from "@every-app/perimeter/manifest";
import { DeployError } from "./errors";

/** Well above a Worker's own limit (10 MB compressed), so it can say so. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_JSON_BYTES = 1024 * 1024;

interface DeployStamp {
  protocol: number;
  /** The app's @every-app/sdk, when the CLI found it. */
  sdkVersion: string | null;
  cliVersion: string;
}

export interface DeployBundle {
  manifest: unknown;
  stamp: DeployStamp;
  /** The default Worker's worker.config.json. */
  worker: Record<string, unknown>;
  /** Bundle files by path relative to the bundle directory. */
  modules: Map<string, Uint8Array>;
  /** Static assets by URL path (`/favicon.ico`). */
  assets: Map<string, Uint8Array>;
  /** Migration files in the order they apply (by name). */
  migrations: Array<{ name: string; sql: string }>;
  /** Auxiliary Build Output Workers of a self-hosted release, by directory. */
  helpers?: Map<string, DeployBundle>;
  /** Release tree retained only for schema/toolchain checks, never executed. */
  releaseFiles?: ReadonlyMap<string, Uint8Array>;
}

const invalid = (message: string) =>
  new DeployError("INVALID_BUNDLE", 400, message);

// No empty segments, no `.` or `..`, no backslashes or control characters.
const SEGMENT = /^(?!\.\.?$)[^/\\\u0000-\u001f]+$/;

function relativePath(path: string, what: string): string {
  if (!path.split("/").every((segment) => SEGMENT.test(segment))) {
    throw invalid(`${what} "${path}" isn't a relative path inside the bundle.`);
  }
  return path;
}

async function jsonPart(form: FormData, name: string): Promise<unknown> {
  const part = form.get(name);
  if (part === null) throw invalid(`The upload has no ${name} part.`);
  const text = typeof part === "string" ? part : await part.text();
  if (text.length > MAX_JSON_BYTES)
    throw invalid(`The ${name} part is too large.`);
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`The ${name} part isn't JSON.`);
  }
}

export function parseStamp(value: unknown): DeployStamp {
  const stamp = (value ?? {}) as Record<string, unknown>;
  const { protocol, sdkVersion, cliVersion } = stamp;
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
    throw invalid("The stamp has no protocol version.");
  }
  if (protocol < MIN_HOSTED_DEPLOY_PROTOCOL) {
    throw new DeployError(
      "PROTOCOL_TOO_OLD",
      426,
      `This CLI packages deploy protocol ${protocol}; the gateway reads ${MIN_HOSTED_DEPLOY_PROTOCOL} or later. Update everyapp and deploy again.`,
    );
  }
  if (sdkVersion !== null && typeof sdkVersion !== "string") {
    throw invalid("The stamp's sdkVersion must be a string or null.");
  }
  if (typeof cliVersion !== "string" || !cliVersion) {
    throw invalid("The stamp has no cliVersion.");
  }
  return { protocol, sdkVersion, cliVersion };
}

/** Parse a deploy upload, or throw DeployError. */
export async function parseDeployUpload(
  request: Request,
): Promise<DeployBundle> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES) {
    throw new DeployError(
      "BUNDLE_TOO_LARGE",
      413,
      `The upload is ${length} bytes; the deploy API takes at most ${MAX_UPLOAD_BYTES}.`,
    );
  }
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    throw invalid("A deploy is a multipart/form-data upload.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw invalid("The upload isn't a readable multipart body.");
  }

  const worker = await jsonPart(form, HOSTED_DEPLOY_PARTS.worker);
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
    throw invalid("The worker part isn't a Worker config.");
  }
  const bundle: DeployBundle = {
    manifest: await jsonPart(form, HOSTED_DEPLOY_PARTS.manifest),
    stamp: parseStamp(await jsonPart(form, HOSTED_DEPLOY_PARTS.stamp)),
    worker: worker as Record<string, unknown>,
    modules: new Map(),
    assets: new Map(),
    migrations: [],
  };

  let files = 0;
  let bytes = 0;
  for (const [name, part] of form.entries()) {
    const kind = [
      HOSTED_DEPLOY_PARTS.modulePrefix,
      HOSTED_DEPLOY_PARTS.assetPrefix,
      HOSTED_DEPLOY_PARTS.migrationPrefix,
    ].find((prefix) => name.startsWith(prefix));
    if (!kind) continue;
    if (typeof part === "string") throw invalid(`Part ${name} must be a file.`);
    files += 1;
    bytes += part.size;
    if (files > MAX_FILES || bytes > MAX_UPLOAD_BYTES) {
      throw new DeployError(
        "BUNDLE_TOO_LARGE",
        413,
        `The upload holds more than ${MAX_FILES} files or ${MAX_UPLOAD_BYTES} bytes.`,
      );
    }
    const path = name.slice(kind.length);
    const content = new Uint8Array(await part.arrayBuffer());
    if (kind === HOSTED_DEPLOY_PARTS.modulePrefix) {
      bundle.modules.set(relativePath(path, "Module"), content);
    } else if (kind === HOSTED_DEPLOY_PARTS.assetPrefix) {
      if (!path.startsWith("/"))
        throw invalid(`Asset "${path}" must start with /.`);
      bundle.assets.set(`/${relativePath(path.slice(1), "Asset")}`, content);
    } else {
      bundle.migrations.push({
        name: relativePath(path, "Migration"),
        sql: new TextDecoder().decode(content),
      });
    }
  }
  bundle.migrations.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return bundle;
}
