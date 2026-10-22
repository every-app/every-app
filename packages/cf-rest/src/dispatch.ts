import { jsonPart, json, type CloudflareTransport } from "./client";
import type {
  ListedWorkerBinding,
  WorkerMetadata,
  WorkerModule,
  WorkerModuleType,
  WorkerSettings,
  WorkerSettingsResult,
} from "./types";

export interface DispatchNamespace {
  namespace_id: string;
  namespace_name: string;
  created_on?: string;
  modified_on?: string;
  script_count?: number;
  trusted_workers?: boolean;
}

/** A script as Cloudflare reports it after an upload or in a listing. */
export interface DispatchScript {
  id: string;
  etag?: string;
  tags?: string[] | null;
  compatibility_date?: string;
  compatibility_flags?: string[];
  has_assets?: boolean;
  has_modules?: boolean;
  handlers?: string[];
  migration_tag?: string;
  usage_model?: string;
  created_on?: string;
  modified_on?: string;
}

export interface DispatchScriptDetails {
  dispatch_namespace: string;
  created_on?: string;
  modified_on?: string;
  script: DispatchScript;
}

export interface DispatchScriptSecret {
  name: string;
  type: "secret_text" | "secret_key";
}

/**
 * Which tags a script must (true) or must not (false) carry, e.g.
 * `{ "org:acme": true }`. Cloudflare matches all of them.
 */
export type TagFilter = Record<string, boolean>;

export interface DeleteByTagsResult {
  deleted?: Array<{ id: string }>;
  deleted_count?: number;
  has_more?: boolean;
}

/**
 * Part content types for module Workers, as wrangler sends them: an "esm"
 * part must be application/javascript+module or Cloudflare runs it as a
 * service-worker script.
 */
export const MODULE_CONTENT_TYPES: Record<WorkerModuleType, string> = {
  esm: "application/javascript+module",
  cjs: "application/javascript",
  text: "text/plain",
  data: "application/octet-stream",
  wasm: "application/wasm",
  sourcemap: "application/source-map",
};

const TAG_PATTERN = /^[^,&:]+$/;
/** How many tags the API lets a script carry. */
const MAX_TAGS = 10;

function assertTag(tag: string): void {
  // The API forbids "," and "&"; ":" would be read as the filter's
  // yes/no separator.
  if (!TAG_PATTERN.test(tag) || tag.length > 1024) {
    throw new Error(`Invalid Worker tag: ${JSON.stringify(tag)}`);
  }
}

/** A script's whole tag list, as an upload or a replacement sets it. */
function assertTags(tags: readonly string[]): void {
  if (tags.length > MAX_TAGS) {
    throw new Error(
      `A Worker can carry at most ${MAX_TAGS} tags, not ${tags.length}`,
    );
  }
  for (const tag of tags) assertTag(tag);
}

/** Both account and dispatch Workers use the same multipart upload format. */
export function workerUploadForm(
  script: string,
  { metadata, modules }: { metadata: WorkerMetadata; modules: WorkerModule[] },
): FormData {
  const names = new Set(modules.map((module) => module.name));
  if (names.size !== modules.length)
    throw new Error(`Duplicate module names in ${script}`);
  if (!names.has(metadata.main_module))
    throw new Error(
      `main_module ${metadata.main_module} is not among the modules of ${script}`,
    );
  assertTags(metadata.tags ?? []);
  const form = new FormData();
  form.set("metadata", jsonPart(metadata));
  for (const module of modules) {
    const content =
      typeof module.content === "string"
        ? module.content
        : new Uint8Array(module.content);
    form.set(
      module.name,
      new File([content], module.name, {
        type: MODULE_CONTENT_TYPES[module.type],
      }),
    );
  }
  return form;
}

function tagQuery(filter: TagFilter): string {
  const entries = Object.entries(filter);
  for (const [tag] of entries) assertTag(tag);
  return entries
    .map(([tag, allowed]) => `${tag}:${allowed ? "yes" : "no"}`)
    .join(",");
}

/** Workers for Platforms: dispatch namespaces. */
export function dispatchNamespaces(transport: CloudflareTransport) {
  const path = (...segments: string[]) =>
    transport.accountPath("workers", "dispatch", "namespaces", ...segments);
  return {
    list: () =>
      transport.request<DispatchNamespace[]>(
        path(),
        {},
        {
          context: "List dispatch namespaces",
        },
      ),
    get: (name: string) =>
      transport.request<DispatchNamespace>(
        path(name),
        {},
        {
          context: `Get dispatch namespace ${name}`,
        },
      ),
    create: (name: string) =>
      transport.request<DispatchNamespace>(path(), json("POST", { name }), {
        context: `Create dispatch namespace ${name}`,
      }),
    delete: (name: string) =>
      transport.request<null>(
        path(name),
        { method: "DELETE" },
        {
          context: `Delete dispatch namespace ${name}`,
        },
      ),
  };
}

/** Workers for Platforms: the scripts (user Workers) in a dispatch namespace. */
export function dispatchScripts(transport: CloudflareTransport) {
  const scripts = (namespace: string, ...segments: string[]) =>
    transport.accountPath(
      "workers",
      "dispatch",
      "namespaces",
      namespace,
      "scripts",
      ...segments,
    );
  const label = (namespace: string, script: string) => `${namespace}/${script}`;

  return {
    /**
     * Upload a module Worker: a new version, deployed at once. Every
     * module is a part named by its filename; `metadata.main_module` must
     * name one of them.
     */
    upload: async (
      namespace: string,
      script: string,
      upload: { metadata: WorkerMetadata; modules: WorkerModule[] },
    ) => {
      return transport.request<DispatchScript>(
        scripts(namespace, script),
        {
          method: "PUT",
          body: workerUploadForm(label(namespace, script), upload),
        },
        { context: `Upload dispatch script ${label(namespace, script)}` },
      );
    },
    get: (namespace: string, script: string) =>
      transport.request<DispatchScriptDetails>(
        scripts(namespace, script),
        {},
        {
          context: `Get dispatch script ${label(namespace, script)}`,
        },
      ),
    bindings: (namespace: string, script: string) =>
      transport.request<ListedWorkerBinding[]>(
        scripts(namespace, script, "bindings"),
        {},
        {
          context: `Get bindings of dispatch script ${label(namespace, script)}`,
        },
      ),
    /** `force` deletes it even while other Workers still bind it. */
    delete: (
      namespace: string,
      script: string,
      options: { force?: boolean } = {},
    ) =>
      transport.request<null>(
        `${scripts(namespace, script)}${options.force ? "?force=true" : ""}`,
        { method: "DELETE" },
        { context: `Delete dispatch script ${label(namespace, script)}` },
      ),
    getSettings: (namespace: string, script: string) =>
      transport.request<WorkerSettingsResult>(
        scripts(namespace, script, "settings"),
        {},
        {
          context: `Get settings of dispatch script ${label(namespace, script)}`,
        },
      ),
    /**
     * Change settings without uploading code. `bindings`, when given,
     * replaces them all: carry the others over as `{ type: "inherit" }`.
     */
    patchSettings: async (
      namespace: string,
      script: string,
      settings: WorkerSettings,
    ) => {
      assertTags(settings.tags ?? []);
      const form = new FormData();
      form.set("settings", jsonPart(settings));
      return transport.request<WorkerSettingsResult>(
        scripts(namespace, script, "settings"),
        { method: "PATCH", body: form },
        {
          context: `Patch settings of dispatch script ${label(namespace, script)}`,
        },
      );
    },
    listSecrets: (namespace: string, script: string) =>
      transport.request<DispatchScriptSecret[]>(
        scripts(namespace, script, "secrets"),
        {},
        {
          context: `List secrets of dispatch script ${label(namespace, script)}`,
        },
      ),
    putSecret: (
      namespace: string,
      script: string,
      name: string,
      text: string,
    ) =>
      transport.request<DispatchScriptSecret>(
        scripts(namespace, script, "secrets"),
        json("PUT", { name, text, type: "secret_text" }),
        {
          context: `Put secret ${name} on dispatch script ${label(namespace, script)}`,
        },
      ),
    deleteSecret: (namespace: string, script: string, name: string) =>
      transport.request<null>(
        scripts(namespace, script, "secrets", name),
        { method: "DELETE" },
        {
          context: `Delete secret ${name} of dispatch script ${label(namespace, script)}`,
        },
      ),
    /**
     * Set and delete many secrets in one new version (a JSON merge patch):
     * a string sets the secret, null deletes it, an absent name is kept.
     */
    patchSecrets: (
      namespace: string,
      script: string,
      secrets: Record<string, string | null>,
    ) =>
      transport.request<Record<string, DispatchScriptSecret>>(
        scripts(namespace, script, "secrets-bulk"),
        json("PATCH", {
          secrets: Object.fromEntries(
            Object.entries(secrets).map(([name, text]) => [
              name,
              text === null ? null : { name, text, type: "secret_text" },
            ]),
          ),
        }),
        {
          context: `Patch secrets of dispatch script ${label(namespace, script)}`,
        },
      ),
    getTags: (namespace: string, script: string) =>
      transport.request<string[] | null>(
        scripts(namespace, script, "tags"),
        {},
        {
          context: `Get tags of dispatch script ${label(namespace, script)}`,
        },
      ),
    /** Replace the script's tags. */
    setTags: async (namespace: string, script: string, tags: string[]) => {
      assertTags(tags);
      return transport.request<string[] | null>(
        scripts(namespace, script, "tags"),
        json("PUT", tags),
        { context: `Set tags of dispatch script ${label(namespace, script)}` },
      );
    },
    addTag: async (namespace: string, script: string, tag: string) => {
      assertTag(tag);
      return transport.request<unknown>(
        scripts(namespace, script, "tags", tag),
        { method: "PUT" },
        { context: `Tag dispatch script ${label(namespace, script)} ${tag}` },
      );
    },
    removeTag: async (namespace: string, script: string, tag: string) => {
      assertTag(tag);
      return transport.request<unknown>(
        scripts(namespace, script, "tags", tag),
        { method: "DELETE" },
        { context: `Untag dispatch script ${label(namespace, script)} ${tag}` },
      );
    },
    /** Every script in the namespace, or those matching `tags`. */
    list: (namespace: string, tags?: TagFilter) =>
      transport.request<DispatchScriptDetails[]>(
        tags && Object.keys(tags).length > 0
          ? `${scripts(namespace)}?tags=${encodeURIComponent(tagQuery(tags))}`
          : scripts(namespace),
        {},
        { context: `List dispatch scripts in ${namespace}` },
      ),
    /**
     * Delete the scripts matching `tags`, e.g. all of an organization's.
     * At least one tag must be required (true): a filter of exclusions
     * alone would empty most of the namespace.
     */
    deleteByTags: async (
      namespace: string,
      tags: TagFilter,
      options: { limit?: number } = {},
    ) => {
      if (!Object.values(tags).some(Boolean)) {
        throw new Error(
          `Refusing to delete scripts in ${namespace} without a required tag`,
        );
      }
      const query = new URLSearchParams({ tags: tagQuery(tags) });
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return transport.request<DeleteByTagsResult | null>(
        `${scripts(namespace)}?${query}`,
        { method: "DELETE" },
        {
          context: `Delete dispatch scripts in ${namespace} tagged ${tagQuery(tags)}`,
          envelopeOptional: true,
        },
      );
    },
  };
}
