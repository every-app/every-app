/**
 * A provider registered on a gateway, in local development
 * (docs/design/2026-10-provider-registry.md, section 4). There is no
 * gateway to ask in `everyapp dev`, so the spec comes from the app's
 * directory: `everyapp provider add` (run in an app directory) and
 * `everyapp provider show <id> --save` write it to
 * `.everyapp/providers/<id>.json`, `everyAppWorker()` reads every such
 * file when it builds the dev Worker and hands them over as one text
 * binding, {@link DEV_PROVIDERS_ENV}, and `integrationFetch()`'s local
 * fallback resolves an id outside the catalog from it, with the
 * developer's own key from `.dev.vars` under the spec's setting names.
 *
 * The binding is JSON: `[{ "file": ".everyapp/providers/stripe.json",
 * "spec": <the file's JSON, or its text when it isn't JSON> }]`. Each spec
 * is parsed here, with the same parser `provider add` uses; one that
 * doesn't parse is ignored until an app asks for its id, which then gets
 * a ConfigurationError naming the file.
 */
import {
  describeSpecProblems,
  parseProviderSpec,
  type RegistrableCapability,
} from "./providerSpec.js";

/** The dev Worker's binding holding the specs (a copy is in ../cloudflare/worker.ts, kept in step by a test). */
export const DEV_PROVIDERS_ENV = "EVERYAPP_DEV_PROVIDERS";

/** Where the specs live in an app, relative to its directory. */
export const DEV_PROVIDERS_DIR = ".everyapp/providers";

/** One file as the binding carries it. */
export interface DevProviderFile {
  /** Relative to the app: `.everyapp/providers/stripe.json`. */
  file: string;
  /** The file's JSON, or its text when it isn't JSON. */
  spec: unknown;
}

/** The file `everyapp dev` reads a registered provider's spec from. */
export function devProviderFile(id: string): string {
  return `${DEV_PROVIDERS_DIR}/${id}.json`;
}

/** A registered provider resolved for local development, or why it can't be. */
export type DevProviderLookup =
  | { found: true; capability: RegistrableCapability; file: string }
  | { found: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The files the binding carries; none when it is absent or not of its shape. */
function devProviderFiles(value: unknown): DevProviderFile[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): DevProviderFile[] =>
    isRecord(entry) && typeof entry["file"] === "string"
      ? [{ file: entry["file"], spec: entry["spec"] }]
      : [],
  );
}

/**
 * `id`'s spec from the dev Worker's {@link DEV_PROVIDERS_ENV}: a file whose
 * spec says that id, or whose name is `<id>.json`. A file that matches but
 * doesn't parse (or names another id) is the problem; no file is too,
 * naming the command that writes one.
 */
export function resolveDevProvider(
  values: Readonly<Record<string, unknown>>,
  id: string,
): DevProviderLookup {
  const files = devProviderFiles(values[DEV_PROVIDERS_ENV]);
  const matching = files.filter(
    (entry) =>
      (isRecord(entry.spec) && entry.spec["id"] === id) ||
      entry.file.split("/").at(-1) === `${id}.json`,
  );
  let problem: string | null = null;
  for (const entry of matching) {
    const parsed = parseProviderSpec(
      typeof entry.spec === "string" ? null : entry.spec,
    );
    if (!parsed.ok) {
      problem ??=
        typeof entry.spec === "string"
          ? `${entry.file} isn't JSON`
          : `${entry.file} isn't a provider spec: ${describeSpecProblems(parsed.problems)}`;
      continue;
    }
    if (parsed.id !== id) {
      problem ??= `${entry.file} is ${parsed.id}'s spec, not ${id}'s`;
      continue;
    }
    return { found: true, capability: parsed.capability, file: entry.file };
  }
  return {
    found: false,
    problem: problem
      ? `${problem}. Write it again with everyapp provider show ${id} --save in the app's directory, then start everyapp dev again.`
      : `"${id}" isn't in the built-in provider catalog, and no ${devProviderFile(id)} describes it. A provider registered on the gateway (everyapp provider add) is reached through the EVERY_APP_GATEWAY binding; for everyapp dev, run everyapp provider show ${id} --save in the app's directory, then start everyapp dev again.`,
  };
}
