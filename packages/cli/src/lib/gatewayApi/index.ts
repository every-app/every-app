/**
 * The Gateway's admin API, as the CLI reaches it: the built-in tools of the
 * Gateway's own `/mcp` (`everyapp_workspace_*`, `everyapp_ai_*`,
 * `everyapp_my_*`, …), which run through the Gateway's real services, with
 * the person's own credential (ADR-0003, "What the CLI writes"). Every
 * `workspace`, `events` and `ai` command but `ai gateway` is a thin client
 * of one tool, and `everyapp call <tool> [json]` reaches any of them, an
 * app's tools included, so the UI, the CLI and MCP do the same things by
 * construction.
 *
 * Which Gateway: `--gateway <url>`, else EVERYAPP_GATEWAY_URL, else the one
 * Gateway this machine is signed in to, else the one the Cloudflare login
 * finds (`--gateway <name>` picks among several there).
 *
 * The credential: EVERYAPP_TOKEN (a personal access token, `epat_…`, made
 * under Manage workspace → Tokens; read-only or bound to one app as made),
 * else the sign-in `everyapp login --gateway` stored, else that sign-in now
 * (the browser opens at the Gateway's consent page; under --json the link
 * is in a progress event and the run waits). The sign-in is the Gateway's
 * own OAuth server with the resource `<gateway>/mcp`, the same grant an AI
 * app gets (lib/linkedDev/oauth.ts): the person picks read or read & write
 * and which apps on the consent page, and a grant narrowed to some apps
 * sees no workspace tool. It is kept in `~/.config/everyapp/gateways.json`
 * (0600) and refreshed when stale.
 *
 * Each call is one stateless 2026-07-28 MCP request (`tools/call`, the
 * client named `everyapp-cli` in its envelope for the audit row). A tool's
 * refusal (`CODE: message`) is GATEWAY_TOOL_ERROR with the Gateway's code
 * in `data.code`.
 */
import os from "node:os";
import path from "node:path";
import { EveryAppError, errorMessage } from "@/lib/errors";
import { existingGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { gatewayOrigin } from "@/lib/linkedDev";
import {
  authorize,
  discover,
  refresh,
  registerClient,
  revoke,
  type ServerMetadata,
  type Tokens,
} from "@/lib/linkedDev/oauth";
import { openLinkedDevStore, type LinkedDevEntry, type LinkedDevStore } from "@/lib/linkedDev/store";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { cliVersion } from "@/lib/version";

/** A JSON object, as a tool takes and answers it. */
export type JsonObject = Record<string, unknown>;

/** The store entry's `appId` for a sign-in to the Gateway's `/mcp`. */
const MCP_ENTRY = "mcp";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "everyapp-cli", version: cliVersion };
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const SIGNIN_STEP = "gateway.signin";

/** `$XDG_CONFIG_HOME/everyapp/gateways.json`, else `~/.config/everyapp/gateways.json`. */
function gatewaySessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(configHome, "everyapp", "gateways.json");
}

/** The flags every admin API command takes. */
export interface GatewayApiFlags {
  gateway?: string;
  "account-id"?: string;
  json?: boolean;
}

interface GatewayApiOptions {
  flags: GatewayApiFlags;
  out: EventSink;
  /** Tests: the environment, the store, fetch, the browser, Cloudflare discovery. */
  env?: NodeJS.ProcessEnv;
  store?: LinkedDevStore;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<unknown>;
  findGateway?: (flags: GatewayApiFlags, out: EventSink) => Promise<string>;
}

/** A tool as `tools/list` lists it. */
interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: JsonObject;
}

export interface GatewayApi {
  /** The Gateway's origin. */
  readonly gateway: string;
  /** Run one tool; its structured answer (or its text, parsed when it is JSON). */
  call(name: string, args?: JsonObject): Promise<JsonObject>;
  /** Every tool the credential may call, apps' tools included. */
  list(): Promise<ListedTool[]>;
}

interface Credential {
  token(): Promise<string>;
  /**
   * A 401 came back: refresh a stored sign-in once (true: retry with the new
   * token). A sign-in the token endpoint refuses is forgotten, so the next
   * run signs in again; a network error forgets nothing.
   */
  renew(): Promise<boolean>;
  /** A 401 came back even after a renewal: forget a stored sign-in. */
  forget(): void;
  readonly kind: "token" | "signin";
}

/** The token endpoint refused the grant itself (invalid_grant and the like), not a network failure. */
const grantRefused = (error: unknown) =>
  error instanceof EveryAppError &&
  error.code === "OAUTH_SIGNIN_FAILED" &&
  [400, 401].includes(Number(error.data?.["status"]));

/**
 * The Gateway `flags` name, as an origin: a URL from `--gateway` or
 * EVERYAPP_GATEWAY_URL, else the one this machine signed in to, else the
 * one the Cloudflare login finds.
 */
async function resolveGateway(options: GatewayApiOptions, store: LinkedDevStore): Promise<string> {
  const { flags, out } = options;
  const env = options.env ?? process.env;
  const named = flags.gateway?.trim();
  if (named && named.includes("://")) return gatewayOrigin(named);
  const fromEnv = env["EVERYAPP_GATEWAY_URL"]?.trim();
  if (!named && fromEnv) return gatewayOrigin(fromEnv);
  if (!named) {
    const signedIn = [...new Set(store.list().filter((entry) => entry.appId === MCP_ENTRY).map((entry) => entry.gateway))];
    if (signedIn.length === 1) return signedIn[0]!;
    if (signedIn.length > 1) {
      throw new EveryAppError(
        "GATEWAY_AMBIGUOUS",
        `This machine is signed in to ${signedIn.length} Gateways: ${signedIn.join(", ")}\nSay which with --gateway <url> (or EVERYAPP_GATEWAY_URL).`,
        { data: { gateways: signedIn } },
      );
    }
  }
  const find = options.findGateway ?? findThroughCloudflare;
  return find(flags, out);
}

/** The Gateway the Cloudflare login finds (a name in `--gateway` picks among several). */
async function findThroughCloudflare(flags: GatewayApiFlags, out: EventSink): Promise<string> {
  const found = await existingGateway({
    json: flags.json,
    out,
    accountId: flags["account-id"],
    gateway: requestedGatewayUrl(flags.gateway),
  });
  if (!found.install) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      `Which Gateway?\nPass --gateway https://<your gateway> (or set EVERYAPP_GATEWAY_URL).`,
    );
  }
  return `https://${found.install.gatewayHost}`;
}

function entryFrom(gateway: string, clientId: string, tokens: Tokens, previous?: LinkedDevEntry): LinkedDevEntry {
  return {
    gateway,
    appId: MCP_ENTRY,
    clientId,
    refreshToken: tokens.refreshToken || previous?.refreshToken || "",
    accessToken: tokens.accessToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    ...(previous?.email ? { email: previous.email } : {}),
    ...(previous?.organization ? { organization: previous.organization } : {}),
    linkedAt: previous?.linkedAt ?? new Date().toISOString(),
  };
}

const mcpResource = (gateway: string) => `${gateway}/mcp`;

/**
 * Sign in to `gateway`'s `/mcp` in the browser and store the grant (step
 * `gateway.signin`; the URL is in its progress event for a run without a
 * browser). `everyapp login --gateway` and the first admin command run it.
 */
export async function signInToGateway(
  gateway: string,
  options: Pick<GatewayApiOptions, "out" | "store" | "fetchImpl" | "openBrowser"> & { json?: boolean },
): Promise<LinkedDevEntry> {
  const store = options.store ?? openLinkedDevStore(gatewaySessionsPath());
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadata = await discover(gateway, fetchImpl);
  const clientId =
    store.list().find((entry) => entry.gateway === gateway)?.clientId ??
    (await registerClient(metadata, `${CLI} on ${os.hostname()}`, fetchImpl));
  options.out.emit({
    type: "step",
    step: SIGNIN_STEP,
    status: "start",
    message: `Signing in to ${gateway}: approve everyapp in the browser (read & write, all apps, for the admin commands)...`,
    data: { gateway },
  });
  const openBrowser =
    options.openBrowser ?? (canPromptInTerminal(options.json ?? false) ? openInBrowser : async () => undefined);
  const tokens = await authorize({
    metadata,
    clientId,
    resource: mcpResource(gateway),
    openBrowser,
    onUrl: (url) =>
      options.out.emit({
        type: "progress",
        step: SIGNIN_STEP,
        message: `If the browser didn't open, visit\n  ${url}`,
        data: { url },
      }),
    fetchImpl,
  });
  const entry = entryFrom(gateway, clientId, tokens);
  store.put(entry);
  options.out.emit({ type: "step", step: SIGNIN_STEP, status: "ok", message: `Signed in to ${gateway}.`, data: { gateway } });
  return entry;
}

/** Revoke the stored sign-in at the Gateway (best effort) and forget it; null when there was none. */
export async function signOutOfGateway(
  gateway: string,
  options: { store?: LinkedDevStore; fetchImpl?: typeof fetch } = {},
): Promise<{ revoked: boolean } | null> {
  const store = options.store ?? openLinkedDevStore(gatewaySessionsPath());
  const entry = store.remove(gateway, MCP_ENTRY);
  if (!entry) return null;
  try {
    const metadata = await discover(gateway, options.fetchImpl ?? fetch);
    return { revoked: await revoke(metadata, entry.clientId, entry.refreshToken, options.fetchImpl ?? fetch) };
  } catch {
    return { revoked: false };
  }
}

/** EVERYAPP_TOKEN, else the stored sign-in, else a sign-in now. */
async function credentialFor(gateway: string, options: GatewayApiOptions, store: LinkedDevStore): Promise<Credential> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pat = env["EVERYAPP_TOKEN"]?.trim();
  if (pat) {
    return { kind: "token", token: async () => pat, renew: async () => false, forget: () => undefined };
  }
  let entry =
    store.get(gateway, MCP_ENTRY) ??
    (await signInToGateway(gateway, {
      out: options.out,
      store,
      fetchImpl,
      openBrowser: options.openBrowser,
      json: options.flags.json,
    }));
  let metadata: ServerMetadata | undefined;
  /**
   * A new access token for the stored grant. When the token endpoint
   * refuses it, another everyapp run may have rotated the refresh token
   * meanwhile: the store's newer entry is taken instead. Only a grant the
   * endpoint refuses, with nothing newer stored, is forgotten.
   */
  const refreshEntry = async (): Promise<string> => {
    metadata ??= await discover(gateway, fetchImpl);
    try {
      const tokens = await refresh(metadata, entry.clientId, entry.refreshToken, mcpResource(gateway), fetchImpl);
      entry = entryFrom(gateway, entry.clientId, tokens, entry);
      store.put(entry);
      return entry.accessToken;
    } catch (error) {
      if (!grantRefused(error)) throw error;
      const stored = store.get(gateway, MCP_ENTRY);
      if (stored && stored.refreshToken !== entry.refreshToken) {
        entry = stored;
        return entry.accessToken;
      }
      store.remove(gateway, MCP_ENTRY);
      throw error;
    }
  };
  return {
    kind: "signin",
    async token() {
      if (Date.parse(entry.expiresAt) - Date.now() > REFRESH_MARGIN_MS) return entry.accessToken;
      return refreshEntry();
    },
    async renew() {
      try {
        await refreshEntry();
        return true;
      } catch (error) {
        if (grantRefused(error)) return false;
        throw error;
      }
    },
    forget: () => {
      store.remove(gateway, MCP_ENTRY);
    },
  };
}

let requestId = 1;

/** One stateless 2026-07-28 request to `<gateway>/mcp`; its JSON-RPC `result`. */
async function rpc(
  gateway: string,
  credential: Credential,
  method: string,
  params: JsonObject,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
): Promise<JsonObject> {
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  let response = await send(gateway, credential, method, name, params, fetchImpl, headers);
  // A sign-in's access token refused (revoked, or expired early under clock
  // skew): refresh it once and try again before giving the sign-in up.
  if (response.status === 401 && (await credential.renew())) {
    response = await send(gateway, credential, method, name, params, fetchImpl, headers);
  }
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    throw new EveryAppError(
      "GATEWAY_REFUSED",
      `${gateway}/mcp redirected the request (${response.status || "redirect"}) instead of answering\nCloudflare Access may stand in front of /mcp (Managed OAuth), or the URL isn't the Gateway's. The credential wasn't sent on.`,
      { fix: "check --gateway, and that /mcp is reachable with a bearer token (docs/agent/access)", data: { gateway, status: response.status } },
    );
  }
  if (response.status === 401 || response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as JsonObject;
    if (response.status === 401) credential.forget();
    const how =
      credential.kind === "token"
        ? "EVERYAPP_TOKEN was refused: it was revoked, has expired, or isn't this Gateway's"
        : "The Gateway no longer takes this machine's sign-in";
    throw new EveryAppError(
      "GATEWAY_REFUSED",
      `${how} (${response.status}${body["reason"] || body["error"] ? ` ${String(body["reason"] ?? body["error"])}` : ""})${typeof body["message"] === "string" ? `\n${body["message"]}` : ""}`,
      {
        fix:
          credential.kind === "token"
            ? "make a new personal access token under Manage workspace → Tokens, or unset EVERYAPP_TOKEN to sign in in the browser"
            : `sign in again: ${CLI} login --gateway ${gateway}`,
        data: { gateway, status: response.status },
      },
    );
  }
  const text = await response.text();
  const message = parseRpc(text);
  if (!response.ok && !message) {
    throw new EveryAppError("GATEWAY_UNREACHABLE", `${gateway}/mcp answered ${response.status}`, {
      retryable: response.status >= 500,
      data: { gateway, status: response.status },
    });
  }
  const error = message?.["error"] as JsonObject | undefined;
  if (error) {
    const unknownTool = typeof error["message"] === "string" && error["message"].startsWith("Unknown tool");
    throw new EveryAppError(
      "GATEWAY_TOOL_ERROR",
      `${gateway} refused ${name ?? method}: ${String(error["message"] ?? "error")}${
        // Why a tool that exists may be missing for this credential; what to do is the fix.
        unknownTool ? "\nA read-only credential sees no write tools. One limited to some apps sees no workspace tools." : ""
      }`,
      {
        ...(unknownTool
          ? {
              fix: `use a read & write token or sign-in for all apps (as an owner or admin for workspace tools). ${CLI} call --list shows what this one may call`,
            }
          : {}),
        data: { gateway, tool: name ?? null, rpcCode: error["code"] ?? null },
      },
    );
  }
  const result = message?.["result"];
  if (!result || typeof result !== "object") {
    throw new EveryAppError("GATEWAY_UNREACHABLE", `${gateway}/mcp answered no result (${response.status})`, {
      data: { gateway, status: response.status },
    });
  }
  return result as JsonObject;
}

/** The request itself; network failures are GATEWAY_UNREACHABLE. */
async function send(
  gateway: string,
  credential: Credential,
  method: string,
  name: string | undefined,
  params: JsonObject,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<Response> {
  const token = await credential.token();
  try {
    return await fetchImpl(mcpResource(gateway), {
      method: "POST",
      // The credential goes to <gateway>/mcp and nowhere else: a redirect
      // (Cloudflare Access's login, a moved host) is refused below.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId++,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
          },
        },
      }),
    });
  } catch (error) {
    throw new EveryAppError("GATEWAY_UNREACHABLE", `Can't reach the Gateway at ${gateway}\n${errorMessage(error)}`, {
      retryable: true,
      data: { gateway },
    });
  }
}

/** The JSON-RPC message of a JSON body, or of the last `data:` line of an event stream. */
function parseRpc(text: string): JsonObject | null {
  const attempt = (value: string): JsonObject | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(text);
  if (direct) return direct;
  const lines = text.split("\n").filter((line) => line.startsWith("data:"));
  for (const line of lines.reverse()) {
    const found = attempt(line.slice(5).trim());
    if (found && ("result" in found || "error" in found)) return found;
  }
  return null;
}

/** A tool's text content, joined. */
function textOf(result: JsonObject): string {
  const content = Array.isArray(result["content"]) ? (result["content"] as JsonObject[]) : [];
  return content
    .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
    .map((part) => String(part["text"]))
    .join("\n");
}

/**
 * The answer of a tool call: its structured content, else its text parsed
 * as JSON, else `{ text }`. A tool error (`isError`) throws
 * GATEWAY_TOOL_ERROR, the Gateway's `CODE` (the part before `: `) in
 * `data.code`.
 */
export function toolAnswer(gateway: string, name: string, result: JsonObject): JsonObject {
  const text = textOf(result);
  if (result["isError"] === true) {
    const match = /^([A-Z][A-Z0-9_]+): ([\s\S]*)$/.exec(text);
    throw new EveryAppError("GATEWAY_TOOL_ERROR", match ? match[2]! : text || `${name} failed`, {
      data: { gateway, tool: name, code: match ? match[1]! : null },
    });
  }
  const structured = result["structuredContent"];
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured as JsonObject;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // Plain text: an app's tool may answer prose.
  }
  return { text };
}

/** The Gateway `options.flags` name, signed in to (or with EVERYAPP_TOKEN). */
export async function openGatewayApi(options: GatewayApiOptions): Promise<GatewayApi> {
  const store = options.store ?? openLinkedDevStore(gatewaySessionsPath(options.env));
  const fetchImpl = options.fetchImpl ?? fetch;
  const gateway = await resolveGateway(options, store);
  const credential = await credentialFor(gateway, options, store);
  return {
    gateway,
    async call(name, args = {}) {
      const result = await rpc(gateway, credential, "tools/call", { name, arguments: args }, fetchImpl);
      return toolAnswer(gateway, name, result);
    },
    async list() {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await rpc(gateway, credential, "tools/list", cursor ? { cursor } : {}, fetchImpl, {
          "x-everyapp-tools": "full",
        });
        tools.push(...((Array.isArray(result["tools"]) ? result["tools"] : []) as ListedTool[]));
        cursor = typeof result["nextCursor"] === "string" ? result["nextCursor"] : undefined;
      } while (cursor);
      return tools;
    },
  };
}
