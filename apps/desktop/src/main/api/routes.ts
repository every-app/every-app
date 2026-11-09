// The /api/v1 routes the window may call through "api:call" (the Scribe backend's web/src/api/contract.ts). Anything
// else is refused before it reaches the network: recording routes (segments,
// transcription-token, audio-chunk) belong to main and the helper. `finish` is allowed: the meeting
// page offers it for a meeting left "recording" that this Mac isn't recording.

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const ID = "[A-Za-z0-9_-]{1,128}";

const routes: [ApiMethod[], RegExp][] = [
  [["GET"], /^api\/v1\/me$/],
  [["GET"], /^api\/v1\/calendar\/upcoming$/],
  [["GET"], /^api\/v1\/search$/],
  [["GET", "PATCH"], /^api\/v1\/settings$/],
  [["GET", "POST"], /^api\/v1\/meetings$/],
  [["GET", "PATCH", "DELETE"], new RegExp(`^api/v1/meetings/${ID}$`)],
  [["PUT"], new RegExp(`^api/v1/meetings/${ID}/(jottings|notes)$`)],
  [["POST"], new RegExp(`^api/v1/meetings/${ID}/share$`)],
  // "Finish" on a meeting left recording (another device, or interrupted); owner-only on the Worker.
  [["POST"], new RegExp(`^api/v1/meetings/${ID}/finish$`)],
  [["DELETE"], new RegExp(`^api/v1/meetings/${ID}/share/${ID}$`)],
  [["GET", "POST"], /^api\/v1\/folders$/],
  [["PATCH", "DELETE"], new RegExp(`^api/v1/folders/${ID}$`)],
  [["PUT", "DELETE"], new RegExp(`^api/v1/folders/${ID}/meetings/${ID}$`)],
  [["GET", "POST"], /^api\/v1\/templates$/],
  [["GET", "PATCH", "DELETE"], new RegExp(`^api/v1/templates/${ID}$`)],
  [["POST"], new RegExp(`^api/v1/templates/${ID}/duplicate$`)],
];

const METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function isAllowedApiCall(method: unknown, path: unknown): method is ApiMethod {
  if (typeof method !== "string" || !METHODS.has(method)) return false;
  if (typeof path !== "string" || path.length > 512) return false;
  return routes.some(([methods, re]) => methods.includes(method as ApiMethod) && re.test(path));
}

export interface ApiCallOptions {
  query?: Record<string, string>;
  body?: unknown;
}

/** Query values are short strings; a body is plain JSON under 512 KB. */
export function isValidApiCallOptions(opts: unknown): opts is ApiCallOptions | undefined {
  if (opts === undefined) return true;
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) return false;
  const o = opts as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "query" && k !== "body")) return false;
  if (o.query !== undefined) {
    if (!o.query || typeof o.query !== "object" || Array.isArray(o.query)) return false;
    const entries = Object.entries(o.query as Record<string, unknown>);
    if (entries.length > 16 || entries.some(([k, v]) => k.length > 32 || typeof v !== "string" || v.length > 512)) return false;
  }
  if (o.body !== undefined) {
    try {
      if (JSON.stringify(o.body).length > 512 * 1024) return false;
    } catch {
      return false;
    }
  }
  return true;
}
