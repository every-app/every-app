// Scribe's /api/v1 over HTTPS with a bearer token (docs/scribe.md "API"), ported from
// mac/Sources/HelperCore/APIClient.swift. Redirects are not followed, so a bounce to the Cloudflare
// Access login is seen as one.

import {
  decodeCreatedMeetingId,
  decodeMe,
  decodeMeetingDetail,
  decodeMeetingList,
  decodeMeetingSummary,
  decodeUpcoming,
  DecodeError,
  type CreateMeetingRequest,
  type Me,
  type MeetingDetail,
  type MeetingPatch,
  type MeetingSummary,
  type UpcomingResponse,
} from "@shared/api";
import { AuthError } from "../auth/errors";
import type { TranscriptSegment } from "@shared/protocol";
import type { AuthProvider } from "../auth/providers";
import type { Fetch } from "../auth/oauth";

export type ApiErrorKind = "signedOut" | "accessLogin" | "server" | "decoding" | "network";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    /** The server's machine-readable `error` (e.g. `ai_route_not_allowed`). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static signedOut(): ApiError {
    return new ApiError("signedOut", "You're signed out. Sign in again.");
  }

  static accessLogin(): ApiError {
    return new ApiError(
      "accessLogin",
      "Gateway requires Sign in with Every App. Its Cloudflare Access login stopped the request, so an access token alone can't reach Scribe.",
    );
  }
}

export class ApiClient {
  constructor(
    readonly auth: AuthProvider,
    private readonly fetchImpl: Fetch = fetch,
    private readonly onOutcome?: (error?: unknown) => void,
  ) {}

  get appUrl(): string {
    return this.auth.appUrl;
  }

  async me(): Promise<Me> {
    return decodeMe(await this.request("GET", "api/v1/me"));
  }

  async upcoming(hours = 24): Promise<UpcomingResponse> {
    try {
      return decodeUpcoming(await this.request("GET", "api/v1/calendar/upcoming", { query: { hours: String(hours) } }));
    } catch (error) {
      // "Google isn't connected" as an error status: ask /me for the connect link.
      if (error instanceof ApiError && error.kind === "server" && [409, 412, 428].includes(error.status ?? 0)) {
        const me = await this.me();
        return { events: [], connected: false, connectUrl: me.connectUrl };
      }
      throw error;
    }
  }

  async meetings(): Promise<MeetingSummary[]> {
    return decodeMeetingList(await this.request("GET", "api/v1/meetings"));
  }

  async meeting(id: string): Promise<MeetingDetail> {
    return decodeMeetingDetail(await this.request("GET", `api/v1/meetings/${encodeURIComponent(id)}`));
  }

  async createMeeting(body: CreateMeetingRequest): Promise<string> {
    return decodeCreatedMeetingId(await this.request("POST", "api/v1/meetings", { json: body }));
  }

  async updateMeeting(id: string, patch: MeetingPatch): Promise<MeetingSummary> {
    const json = await this.request("PATCH", `api/v1/meetings/${encodeURIComponent(id)}`, { json: patch });
    const obj = json && typeof json === "object" && "meeting" in json ? (json as { meeting: unknown }).meeting : json;
    const summary = decodeMeetingSummary(obj);
    if (!summary) throw new ApiError("decoding", new DecodeError("meeting").message);
    return summary;
  }

  /** Idempotent: the Worker answers 404 for a meeting that's already finished, which is done too. */
  async finish(id: string): Promise<void> {
    try {
      await this.request("POST", `api/v1/meetings/${encodeURIComponent(id)}/finish`, { json: {}, empty: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  }

  /** Posts transcript segments (replaying what a recording couldn't save). Idempotent on seq. */
  async appendSegments(id: string, segments: TranscriptSegment[]): Promise<void> {
    await this.request("POST", `api/v1/meetings/${encodeURIComponent(id)}/segments`, { json: { segments }, empty: true });
  }

  /** Deletes a meeting (owner only). Idempotent: 404 means it's already gone. */
  async deleteMeeting(id: string): Promise<void> {
    try {
      await this.request("DELETE", `api/v1/meetings/${encodeURIComponent(id)}`, {});
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  }

  /** One allowlisted /api/v1 call for the window ("api:call"); the caller checked the route. */
  async call(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    return this.request(method, path, { query: opts.query, json: opts.body });
  }

  // Plumbing

  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; empty?: boolean } = {},
  ): Promise<unknown> {
    try {
      const result = await this.requestOnce(method, path, opts);
      this.onOutcome?.();
      return result;
    } catch (error) {
      this.onOutcome?.(error);
      throw error;
    }
  }

  private async requestOnce(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; empty?: boolean },
  ): Promise<unknown> {
    let token: string;
    try {
      token = await this.auth.accessToken();
    } catch (error) {
      throw error instanceof AuthError && error.kind === "signedOut" ? ApiError.signedOut() : error;
    }
    let response = await this.send(method, path, opts, token);
    // Before the 401 handling: Access can answer 401/403 too, and that isn't a dead token.
    let body = await response.text();
    if (isAccessLogin(response, body)) throw ApiError.accessLogin();
    if (response.status === 401) {
      try {
        token = await this.auth.tokenRejected(token);
      } catch {
        throw ApiError.signedOut();
      }
      response = await this.send(method, path, opts, token);
      body = await response.text();
      if (isAccessLogin(response, body)) throw ApiError.accessLogin();
      if (response.status === 401) throw ApiError.signedOut();
    }
    if (response.status < 200 || response.status >= 300) {
      const { code, message } = errorParts(body);
      throw new ApiError("server", message ?? `Scribe answered HTTP ${response.status}.`, response.status, code);
    }
    if (opts.empty) return undefined;
    // A gateway that bounced us to a login page answers 200 with HTML.
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new ApiError(
        "server",
        "Got a web page instead of the API. Is the app URL right, and is the token allowed through?",
        response.status,
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ApiError("decoding", `Scribe sent something unexpected (${path}).`);
    }
  }

  private async send(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; json?: unknown },
    token: string,
  ): Promise<Response> {
    const url = new URL(path, this.appUrl.endsWith("/") ? this.appUrl : `${this.appUrl}/`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ApiError("network", `Couldn't reach Scribe: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isAccessHost(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/** Whether Cloudflare Access answered instead of the app: a redirect to (or a page from)
 * `*.cloudflareaccess.com`, or Access's own login page. */
export function isAccessLogin(response: Pick<Response, "status" | "headers" | "url">, body: string): boolean {
  if (isAccessHost(response.url)) return true;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (isAccessHost(location) || (location ?? "").includes("/cdn-cgi/access/")) return true;
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return false;
  const page = body.slice(0, 64 * 1024).toLowerCase();
  return page.includes("cloudflareaccess.com") || page.includes("/cdn-cgi/access/");
}

/** `{ error: code, message? }` (SPEC), or `{ error: { code, message } }`, or `{ message }`. */
export function errorParts(body: string): { code?: string; message?: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {};
  }
  if (!json || typeof json !== "object") return {};
  const o = json as Record<string, unknown>;
  if (typeof o.error === "string") return { code: o.error, message: typeof o.message === "string" ? o.message : o.error };
  if (o.error && typeof o.error === "object") {
    const e = o.error as Record<string, unknown>;
    return { code: typeof e.code === "string" ? e.code : undefined, message: typeof e.message === "string" ? e.message : undefined };
  }
  return { message: typeof o.message === "string" ? o.message : undefined };
}
