/**
 * The Cloudflare REST API of a FakeCloudflare account, as a fetch: what
 * the hosted deployer (through the gateway's cf-rest client) calls, answered from the
 * same account state the cf-CLI fake uses. Workers for Platforms dispatch
 * namespaces and their scripts are modelled here (uploads parsed from the
 * real multipart body, bindings resolved and stored, secrets, settings,
 * tags, static assets); D1 runs on the account's SQLite databases; the
 * account's Workers are the ones `cf deploy` put there.
 *
 * Envelopes, status codes and the error codes the client branches on
 * (10007, 7000, 10000) are Cloudflare's. Codes for the rest (an existing
 * namespace, a bad binding) are plausible stand-ins: assert on status and
 * isCloudflareNotFound, not on them.
 */
import type { SqliteD1 } from "./sqliteD1";

export const FAKE_API_TOKEN = "fake-cloudflare-api-token";
const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";

type Json = Record<string, any>;

/** A script in a dispatch namespace, as the latest upload left it. */
interface FakeDispatchScript {
  name: string;
  etag: string;
  /** Upload and settings changes each make a version. */
  versions: number;
  createdOn: string;
  modifiedOn: string;
  mainModule: string;
  /** Part name → its content type and text, as uploaded. */
  modules: Record<string, { contentType: string; content: string }>;
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** Resolved bindings; secret_text ones keep their text (the API never returns it). */
  bindings: Json[];
  tags: string[];
  limits?: Json;
  observability?: Json;
  placement?: Json;
  tailConsumers?: Json[];
  logpush?: boolean;
  usageModel?: string;
  /** Path → hash of the static assets the script serves, if any. */
  assets: Record<string, string> | null;
  assetsConfig?: Json;
}

export interface FakeDispatchNamespace {
  id: string;
  name: string;
  createdOn: string;
  trustedWorkers: boolean;
  scripts: Map<string, FakeDispatchScript>;
}

interface RecordedApiCall {
  method: string;
  /** Path below /client/v4, e.g. /accounts/<id>/d1/database. */
  path: string;
  search: string;
}

/** What the API reads and changes of the account. */
interface FakeAccountState {
  accountId: string;
  databases: Map<string, { name: string; db: SqliteD1 }>;
  workers: Map<string, unknown>;
  dispatchNamespaces: Map<string, FakeDispatchNamespace>;
  createDatabase(name: string): { uuid: string };
  nextId(): number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const notFoundRoute = () => new ApiError(404, 7000, "No route for that URI");
const scriptNotFound = () =>
  new ApiError(404, 10007, "This Worker does not exist on your account.");
const invalid = (message: string) => new ApiError(400, 10021, message);

const TAG = /^[^,&]{1,1024}$/;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function envelope(result: unknown, status = 200): Response {
  return Response.json(
    { success: true, errors: [], messages: [], result },
    { status },
  );
}

function failure(error: ApiError): Response {
  return Response.json(
    {
      success: false,
      errors: [{ code: error.code, message: error.message }],
      messages: [],
      result: null,
    },
    { status: error.status },
  );
}

/** A binding as GET /bindings and GET /settings list it: no secret text. */
function listed(binding: Json): Json {
  if (binding["type"] !== "secret_text") return binding;
  const { text: _text, ...rest } = binding;
  return rest;
}

/** `a:yes,b:no` → [["a", true], ["b", false]]; the tag is up to the last colon. */
function parseTagFilter(value: string): Array<[string, boolean]> {
  return value.split(",").map((pair) => {
    const colon = pair.lastIndexOf(":");
    const allowed = pair.slice(colon + 1);
    if (colon <= 0 || (allowed !== "yes" && allowed !== "no")) {
      throw new ApiError(400, 10021, `Invalid tags filter: ${pair}`);
    }
    return [pair.slice(0, colon), allowed === "yes"];
  });
}

function matchesTags(script: FakeDispatchScript, filter: Array<[string, boolean]>): boolean {
  return filter.every(([tag, allowed]) => script.tags.includes(tag) === allowed);
}

async function jsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 10026, "Could not parse request body.");
  }
}

async function formBody(request: Request): Promise<FormData> {
  if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data; boundary=")) {
    throw new ApiError(400, 10026, "Expected a multipart/form-data body with a boundary.");
  }
  try {
    return await request.formData();
  } catch {
    throw new ApiError(400, 10026, "Could not parse request body.");
  }
}

/** A JSON part of a multipart body, sent as a file or as a plain field. */
async function jsonPart(form: FormData, name: string): Promise<Json> {
  const part = form.get(name);
  if (part === null) throw new ApiError(400, 10026, `Missing ${name} part.`);
  try {
    return JSON.parse(typeof part === "string" ? part : await part.text());
  } catch {
    throw new ApiError(400, 10026, `Could not parse the ${name} part as JSON.`);
  }
}

export class FakeCloudflareApi {
  readonly calls: RecordedApiCall[] = [];
  /** Assets Cloudflare already holds, by hash. */
  readonly assetBlobs = new Map<string, { contentType: string; base64: string }>();
  private readonly assetSessions = new Map<
    string,
    { manifest: Record<string, { hash: string; size: number }>; pending: Set<string> }
  >();
  /** Completion JWT → the manifest it vouches for. */
  private readonly assetCompletions = new Map<string, Record<string, string>>();

  constructor(private readonly account: FakeAccountState) {}

  /** The API as a fetch, for `createCloudflareRest({ fetch })`. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.slice(API_PREFIX.length);
    this.calls.push({ method: request.method, path, search: url.search });
    try {
      if (url.origin !== API_ORIGIN || !url.pathname.startsWith(`${API_PREFIX}/`)) {
        throw notFoundRoute();
      }
      return await this.route(request, url, path);
    } catch (error) {
      if (error instanceof ApiError) return failure(error);
      throw error;
    }
  };

  private authorize(request: Request, token = FAKE_API_TOKEN): void {
    if (request.headers.get("Authorization") !== `Bearer ${token}`) {
      throw new ApiError(403, 10000, "Authentication error");
    }
  }

  private async route(request: Request, url: URL, path: string): Promise<Response> {
    const segments = path.split("/").slice(1).map(decodeURIComponent);
    const [accounts, accountId, ...rest] = segments;
    if (accounts !== "accounts") throw notFoundRoute();
    // The assets upload is authorized by its session JWT, not the token.
    if (rest.join("/") === "workers/assets/upload" && request.method === "POST") {
      return this.uploadAssets(request, url);
    }
    this.authorize(request);
    if (accountId !== this.account.accountId) {
      throw new ApiError(403, 10000, "Authentication error");
    }
    const method = request.method;
    const [area, kind, ...tail] = rest;

    if (area === "workers" && kind === "dispatch" && tail[0] === "namespaces") {
      return this.dispatch(request, url, method, tail.slice(1));
    }
    if (area === "d1" && kind === "database") return this.d1(request, method, tail);
    if (area === "workers" && kind === "workers") return this.workers(url, method, tail);
    throw notFoundRoute();
  }

  // --- Workers for Platforms ------------------------------------------------

  private namespace(name: string): FakeDispatchNamespace {
    const namespace = this.account.dispatchNamespaces.get(name);
    if (!namespace) throw new ApiError(404, 100119, `Dispatch namespace ${name} not found.`);
    return namespace;
  }

  private namespaceResult(namespace: FakeDispatchNamespace): Json {
    return {
      namespace_id: namespace.id,
      namespace_name: namespace.name,
      created_on: namespace.createdOn,
      modified_on: namespace.createdOn,
      script_count: namespace.scripts.size,
      trusted_workers: namespace.trustedWorkers,
    };
  }

  private scriptResult(script: FakeDispatchScript): Json {
    return {
      id: script.name,
      etag: script.etag,
      tags: script.tags,
      compatibility_date: script.compatibilityDate,
      compatibility_flags: script.compatibilityFlags,
      has_assets: script.assets !== null,
      has_modules: true,
      handlers: ["fetch"],
      usage_model: script.usageModel ?? "standard",
      created_on: script.createdOn,
      modified_on: script.modifiedOn,
      ...(script.observability ? { observability: script.observability } : {}),
    };
  }

  private scriptDetails(namespace: FakeDispatchNamespace, script: FakeDispatchScript): Json {
    return {
      dispatch_namespace: namespace.name,
      created_on: script.createdOn,
      modified_on: script.modifiedOn,
      script: this.scriptResult(script),
    };
  }

  private settingsResult(script: FakeDispatchScript): Json {
    return {
      bindings: script.bindings.map(listed),
      compatibility_date: script.compatibilityDate,
      compatibility_flags: script.compatibilityFlags,
      tags: script.tags,
      logpush: script.logpush ?? false,
      tail_consumers: script.tailConsumers ?? [],
      usage_model: script.usageModel ?? "standard",
      ...(script.limits ? { limits: script.limits } : {}),
      ...(script.observability ? { observability: script.observability } : {}),
      ...(script.placement ? { placement: script.placement } : {}),
    };
  }

  private async dispatch(
    request: Request,
    url: URL,
    method: string,
    segments: string[],
  ): Promise<Response> {
    const [name, scriptsSegment, scriptName, sub, subName, ...extra] = segments;
    if (extra.length > 0) throw notFoundRoute();

    if (name === undefined) {
      if (method === "GET") {
        return envelope(
          [...this.account.dispatchNamespaces.values()].map((ns) => this.namespaceResult(ns)),
        );
      }
      if (method === "POST") {
        const body = await jsonBody(request);
        const nsName = body?.name;
        if (typeof nsName !== "string" || !nsName) throw invalid("A namespace name is required.");
        if (this.account.dispatchNamespaces.has(nsName)) {
          throw new ApiError(409, 100118, `A namespace named ${nsName} already exists.`);
        }
        const namespace: FakeDispatchNamespace = {
          id: `${this.account.nextId().toString(16).padStart(8, "0")}-0000-4000-8000-00000000d15b`,
          name: nsName,
          createdOn: new Date().toISOString(),
          trustedWorkers: false,
          scripts: new Map(),
        };
        this.account.dispatchNamespaces.set(nsName, namespace);
        return envelope(this.namespaceResult(namespace));
      }
      throw notFoundRoute();
    }

    if (scriptsSegment === undefined) {
      const namespace = this.namespace(name);
      if (method === "GET") return envelope(this.namespaceResult(namespace));
      if (method === "DELETE") {
        this.account.dispatchNamespaces.delete(name);
        return envelope(null);
      }
      throw notFoundRoute();
    }
    if (scriptsSegment !== "scripts") throw notFoundRoute();
    const namespace = this.namespace(name);

    if (scriptName === undefined) {
      const tags = url.searchParams.get("tags");
      const filter = tags ? parseTagFilter(tags) : [];
      const matching = [...namespace.scripts.values()].filter((script) =>
        matchesTags(script, filter),
      );
      if (method === "GET") {
        return envelope(matching.map((script) => this.scriptDetails(namespace, script)));
      }
      if (method === "DELETE") {
        const limit = Number(url.searchParams.get("limit") ?? Number.POSITIVE_INFINITY);
        const deleted = matching.slice(0, limit);
        for (const script of deleted) namespace.scripts.delete(script.name);
        // Documented without the envelope.
        return Response.json({
          deleted: deleted.map((script) => ({ id: script.name })),
          deleted_count: deleted.length,
          has_more: deleted.length < matching.length,
        });
      }
      throw notFoundRoute();
    }

    if (sub === undefined) {
      if (method === "PUT") return this.uploadScript(request, url, namespace, scriptName);
      const script = this.script(namespace, scriptName);
      if (method === "GET") return envelope(this.scriptDetails(namespace, script));
      if (method === "DELETE") {
        namespace.scripts.delete(scriptName);
        return envelope(null);
      }
      throw notFoundRoute();
    }

    if (sub === "assets-upload-session" && subName === undefined && method === "POST") {
      return this.startAssetsSession(request);
    }
    const script = this.script(namespace, scriptName);
    if (sub === "bindings" && subName === undefined && method === "GET") {
      return envelope(script.bindings.map(listed));
    }
    if (sub === "settings" && subName === undefined) {
      if (method === "GET") return envelope(this.settingsResult(script));
      if (method === "PATCH") {
        const settings = await jsonPart(await formBody(request), "settings");
        this.applySettings(script, settings, false);
        this.bump(script);
        return envelope(this.settingsResult(script));
      }
    }
    if (sub === "secrets") return this.secrets(request, method, script, subName);
    if (sub === "secrets-bulk" && subName === undefined && method === "PATCH") {
      const body = await jsonBody(request);
      const secrets = body?.secrets;
      if (typeof secrets !== "object" || secrets === null) {
        throw invalid("secrets must be an object.");
      }
      for (const [secretName, value] of Object.entries(secrets as Json)) {
        if (value === null) {
          script.bindings = script.bindings.filter(
            (binding) => !(binding["name"] === secretName && binding["type"] === "secret_text"),
          );
        } else {
          this.setSecret(script, secretName, value);
        }
      }
      this.bump(script);
      return envelope(
        Object.fromEntries(
          script.bindings
            .filter((binding) => binding["type"] === "secret_text")
            .map((binding) => [binding["name"], listed(binding)]),
        ),
      );
    }
    if (sub === "tags") {
      if (subName === undefined && method === "GET") return envelope(script.tags);
      if (subName === undefined && method === "PUT") {
        script.tags = this.validTags(await jsonBody(request));
        return envelope(script.tags);
      }
      if (subName !== undefined && method === "PUT") {
        script.tags = this.validTags([...new Set([...script.tags, subName])]);
        return envelope(null);
      }
      if (subName !== undefined && method === "DELETE") {
        script.tags = script.tags.filter((tag) => tag !== subName);
        return envelope(null);
      }
    }
    throw notFoundRoute();
  }

  private script(namespace: FakeDispatchNamespace, name: string): FakeDispatchScript {
    const script = namespace.scripts.get(name);
    if (!script) throw scriptNotFound();
    return script;
  }

  private bump(script: FakeDispatchScript): void {
    script.versions += 1;
    script.modifiedOn = new Date().toISOString();
    script.etag = `etag-${script.name}-${script.versions}`;
  }

  private validTags(tags: unknown): string[] {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !TAG.test(tag))) {
      throw invalid("Tags must be strings without ',' or '&'.");
    }
    if (tags.length > 10) throw invalid("A script can have at most 10 tags.");
    return [...new Set(tags as string[])];
  }

  private setSecret(script: FakeDispatchScript, name: string, value: Json): void {
    if (value["type"] !== "secret_text" || typeof value["text"] !== "string") {
      throw invalid(`Secret ${name} must be a secret_text with text.`);
    }
    if (!BINDING_NAME.test(name)) throw invalid(`Invalid binding name ${name}.`);
    if (script.bindings.some((b) => b["name"] === name && b["type"] !== "secret_text")) {
      throw invalid(`Binding name ${name} is already in use.`);
    }
    script.bindings = [
      ...script.bindings.filter((binding) => binding["name"] !== name),
      { type: "secret_text", name, text: value["text"] },
    ];
  }

  private async secrets(
    request: Request,
    method: string,
    script: FakeDispatchScript,
    name: string | undefined,
  ): Promise<Response> {
    const secrets = script.bindings.filter((binding) => binding["type"] === "secret_text");
    if (name === undefined && method === "GET") return envelope(secrets.map(listed));
    if (name === undefined && method === "PUT") {
      const body = await jsonBody(request);
      if (typeof body?.name !== "string") throw invalid("A secret name is required.");
      this.setSecret(script, body.name, body);
      this.bump(script);
      return envelope({ name: body.name, type: "secret_text" });
    }
    if (name !== undefined) {
      const secret = secrets.find((binding) => binding["name"] === name);
      if (!secret) throw new ApiError(404, 10056, `Secret ${name} not found.`);
      if (method === "GET") return envelope(listed(secret));
      if (method === "DELETE") {
        script.bindings = script.bindings.filter((binding) => binding !== secret);
        this.bump(script);
        return envelope(null);
      }
    }
    throw notFoundRoute();
  }

  /**
   * Resolve an upload's or a settings patch's bindings against the
   * script's current ones, and check each refers to something that exists.
   */
  private resolveBindings(
    previous: Json[],
    bindings: unknown,
    strictInherit: boolean,
  ): Json[] {
    if (!Array.isArray(bindings)) throw invalid("bindings must be an array.");
    const resolved: Json[] = [];
    for (const binding of bindings as Json[]) {
      const name = binding?.["name"];
      if (typeof name !== "string" || !BINDING_NAME.test(name)) {
        throw new ApiError(400, 10052, `A binding has an invalid name: ${JSON.stringify(name)}.`);
      }
      if (resolved.some((other) => other["name"] === name)) {
        throw invalid(`Binding name ${name} is used twice.`);
      }
      if (binding["type"] === "inherit") {
        const from = previous.find(
          (other) => other["name"] === (binding["old_name"] ?? name),
        );
        if (from) resolved.push({ ...from, name });
        else if (strictInherit) {
          throw new ApiError(400, 10057, `Binding ${name} could not be inherited.`);
        }
        continue;
      }
      this.checkBinding(binding);
      resolved.push(binding);
    }
    return resolved;
  }

  private checkBinding(binding: Json): void {
    const { type, name } = binding;
    const need = (...fields: string[]) => {
      for (const field of fields) {
        if (typeof binding[field] !== "string" || !binding[field]) {
          throw invalid(`Binding ${name} (${type}) needs ${field}.`);
        }
      }
    };
    switch (type) {
      case "plain_text":
      case "secret_text":
        need("text");
        return;
      case "json":
        if (!("json" in binding)) throw invalid(`Binding ${name} (json) needs json.`);
        return;
      case "d1":
        need("id");
        if (!this.account.databases.has(binding["id"])) {
          throw invalid(`Binding ${name}: D1 database ${binding["id"]} not found.`);
        }
        return;
      case "kv_namespace":
        need("namespace_id");
        return;
      case "r2_bucket":
        need("bucket_name");
        return;
      case "service":
        need("service");
        if (!this.account.workers.has(binding["service"])) {
          throw new ApiError(
            400,
            10143,
            `Could not resolve service binding '${name}'. Target script '${binding["service"]}' not found.`,
          );
        }
        return;
      case "durable_object_namespace":
        need("class_name");
        return;
      case "workflow":
        need("workflow_name");
        return;
      case "hyperdrive":
        need("id");
        return;
      case "assets":
      case "ai":
      case "version_metadata":
        return;
      default:
        throw invalid(`Binding ${name} has an unsupported type ${JSON.stringify(type)}.`);
    }
  }

  /** Apply the fields `settings` has; a bindings list replaces the old one. */
  private applySettings(script: FakeDispatchScript, settings: Json, strictInherit: boolean): void {
    if ("bindings" in settings) {
      script.bindings = this.resolveBindings(script.bindings, settings["bindings"], strictInherit);
    }
    if ("tags" in settings && settings["tags"] !== null) {
      script.tags = this.validTags(settings["tags"]);
    }
    if (typeof settings["compatibility_date"] === "string") {
      script.compatibilityDate = settings["compatibility_date"];
    }
    if (Array.isArray(settings["compatibility_flags"])) {
      script.compatibilityFlags = settings["compatibility_flags"];
    }
    if ("limits" in settings) script.limits = settings["limits"];
    if ("observability" in settings) script.observability = settings["observability"];
    if ("placement" in settings) script.placement = settings["placement"];
    if ("tail_consumers" in settings) script.tailConsumers = settings["tail_consumers"];
    if ("logpush" in settings) script.logpush = settings["logpush"];
    if ("usage_model" in settings) script.usageModel = settings["usage_model"];
  }

  /** PUT a module Worker into a namespace: the multipart upload. */
  private async uploadScript(
    request: Request,
    url: URL,
    namespace: FakeDispatchNamespace,
    name: string,
  ): Promise<Response> {
    const form = await formBody(request);
    const metadata = await jsonPart(form, "metadata");
    const mainModule = metadata["main_module"];
    if (typeof mainModule !== "string") {
      throw invalid("metadata.main_module is required for a module Worker.");
    }
    if (typeof metadata["compatibility_date"] !== "string") {
      throw invalid("metadata.compatibility_date is required.");
    }
    const modules: FakeDispatchScript["modules"] = {};
    for (const [partName, part] of form.entries()) {
      if (partName === "metadata") continue;
      if (typeof part === "string") throw invalid(`Module ${partName} must be a file part.`);
      modules[partName] = { contentType: part.type, content: await part.text() };
    }
    const main = modules[mainModule];
    if (!main) throw invalid(`main_module ${mainModule} is not among the uploaded parts.`);
    if (main.contentType !== "application/javascript+module") {
      throw invalid(`main_module ${mainModule} must be application/javascript+module.`);
    }

    const previous = namespace.scripts.get(name);
    const keep = new Set<string>(metadata["keep_bindings"] ?? []);
    const declared = this.resolveBindings(
      previous?.bindings ?? [],
      metadata["bindings"] ?? [],
      url.searchParams.get("bindings_inherit") === "strict",
    );
    const kept = (previous?.bindings ?? []).filter(
      (binding) =>
        keep.has(binding["type"]) &&
        !declared.some((other) => other["name"] === binding["name"]),
    );

    let assets = metadata["keep_assets"] ? (previous?.assets ?? null) : null;
    let assetsConfig = metadata["keep_assets"] ? previous?.assetsConfig : undefined;
    const jwt = metadata["assets"]?.["jwt"];
    if (jwt !== undefined) {
      const manifest = this.assetCompletions.get(jwt);
      if (!manifest) throw invalid("metadata.assets.jwt is not a valid completion token.");
      assets = manifest;
      assetsConfig = metadata["assets"]?.["config"];
    }

    const now = new Date().toISOString();
    const script: FakeDispatchScript = {
      name,
      etag: "",
      versions: previous?.versions ?? 0,
      createdOn: previous?.createdOn ?? now,
      modifiedOn: now,
      mainModule,
      modules,
      compatibilityDate: metadata["compatibility_date"],
      compatibilityFlags: metadata["compatibility_flags"] ?? [],
      bindings: [...kept, ...declared],
      tags: previous?.tags ?? [],
      assets,
      ...(assetsConfig ? { assetsConfig } : {}),
    };
    const { bindings: _bindings, compatibility_date: _date, ...settings } = metadata;
    this.applySettings(script, settings, false);
    this.bump(script);
    namespace.scripts.set(name, script);
    return envelope(this.scriptResult(script));
  }

  private async startAssetsSession(request: Request): Promise<Response> {
    const body = await jsonBody(request);
    const manifest = body?.manifest;
    if (typeof manifest !== "object" || manifest === null) {
      throw invalid("manifest is required.");
    }
    for (const [path, entry] of Object.entries(manifest as Json)) {
      if (!path.startsWith("/") || !/^[0-9a-f]{32}$/.test(entry?.hash ?? "")) {
        throw invalid(`Invalid manifest entry ${path}.`);
      }
    }
    const pending = new Set(
      Object.values(manifest as Record<string, { hash: string }>)
        .map((entry) => entry.hash)
        .filter((hash) => !this.assetBlobs.has(hash)),
    );
    const id = this.account.nextId();
    // With nothing to upload, the session's JWT is the completion token.
    if (pending.size === 0) {
      const jwt = `fake-assets-complete-${id}`;
      this.assetCompletions.set(jwt, hashesByPath(manifest));
      return envelope({ jwt, buckets: [] });
    }
    const jwt = `fake-assets-session-${id}`;
    this.assetSessions.set(jwt, { manifest, pending });
    return envelope({ jwt, buckets: [[...pending]] });
  }

  private async uploadAssets(request: Request, url: URL): Promise<Response> {
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const session = this.assetSessions.get(token);
    if (!session) throw new ApiError(401, 10000, "Authentication error");
    if (url.searchParams.get("base64") !== "true") {
      throw invalid("Assets must be uploaded base64-encoded.");
    }
    const form = await formBody(request);
    for (const [hash, part] of form.entries()) {
      if (!session.pending.has(hash) || typeof part === "string") {
        throw invalid(`Unexpected asset ${hash}.`);
      }
      this.assetBlobs.set(hash, { contentType: part.type, base64: await part.text() });
      session.pending.delete(hash);
    }
    if (session.pending.size > 0) return envelope({}, 202);
    const completion = token.replace("fake-assets-session-", "fake-assets-complete-");
    this.assetCompletions.set(completion, hashesByPath(session.manifest));
    this.assetSessions.delete(token);
    return envelope({ jwt: completion }, 201);
  }

  // --- D1 ---------------------------------------------------------------------

  private async d1(request: Request, method: string, segments: string[]): Promise<Response> {
    const [id, action, ...extra] = segments;
    if (extra.length > 0) throw notFoundRoute();
    if (id === undefined) {
      if (method === "GET") {
        return envelope(
          [...this.account.databases].map(([uuid, entry]) => ({ uuid, name: entry.name })),
        );
      }
      if (method === "POST") {
        const name = (await jsonBody(request))?.name;
        if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
          throw invalid("A valid database name is required.");
        }
        if ([...this.account.databases.values()].some((entry) => entry.name === name)) {
          throw new ApiError(400, 7502, "A database with that name already exists");
        }
        const { uuid } = this.account.createDatabase(name);
        return envelope({ uuid, name, created_at: new Date().toISOString(), version: "production" });
      }
      throw notFoundRoute();
    }
    const entry = this.account.databases.get(id);
    if (!entry) throw new ApiError(404, 7404, `The database ${id} could not be found`);
    if (action === undefined) {
      if (method === "GET") return envelope({ uuid: id, name: entry.name, version: "production" });
      if (method === "DELETE") {
        this.account.databases.delete(id);
        return envelope(null);
      }
      throw notFoundRoute();
    }
    if (action !== "query" || method !== "POST") throw notFoundRoute();
    const body = await jsonBody(request);
    const statements: Array<{ sql: string; params?: unknown[] }> = Array.isArray(body?.batch)
      ? body.batch
      : [body];
    if (statements.some((statement) => typeof statement?.sql !== "string")) {
      throw invalid("Each statement needs sql.");
    }
    try {
      const results = await entry.db.run(
        statements.map(({ sql, params = [] }) => ({
          sql,
          // D1 binds booleans as integers.
          params: params.map((param) =>
            typeof param === "boolean" ? Number(param) : param,
          ) as Array<string | number | null>,
        })),
      );
      return envelope(
        results.map((rows) => ({ results: rows, success: true, meta: { rows_read: rows.length } })),
      );
    } catch (error) {
      throw new ApiError(400, 7500, `${(error as Error).message}: SQLITE_ERROR`);
    }
  }

  // --- Account Workers --------------------------------------------------------

  private workers(url: URL, method: string, segments: string[]): Response {
    const [name, ...extra] = segments;
    if (extra.length > 0) throw notFoundRoute();
    const worker = (workerName: string) => ({
      id: workerName,
      name: workerName,
      tags: [],
      created_on: "2026-10-12T00:00:00Z",
      updated_on: "2026-10-12T00:00:00Z",
    });
    if (name === undefined && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const all = [...this.account.workers.keys()].sort();
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: all.slice((page - 1) * perPage, page * perPage).map(worker),
        result_info: {
          page,
          per_page: perPage,
          total_count: all.length,
          total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        },
      });
    }
    if (name === undefined) throw notFoundRoute();
    if (!this.account.workers.has(name)) throw scriptNotFound();
    if (method === "GET") return envelope(worker(name));
    if (method === "DELETE") {
      this.account.workers.delete(name);
      return envelope(null);
    }
    throw notFoundRoute();
  }
}

function hashesByPath(
  manifest: Record<string, { hash: string; size: number }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest).map(([path, entry]) => [path, entry.hash]),
  );
}
