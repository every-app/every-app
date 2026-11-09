// The browser's request to the RFC 8252 loopback redirect (port of HelperCore/LoopbackRedirect.swift).

import { constantTimeEqual } from "./pkce";
import { normalized } from "./url";

export const CALLBACK_PATH = "/callback";

export type RedirectOutcome =
  /** The authorization server sent a code and the state matched. */
  | { kind: "code"; code: string }
  /** The authorization server sent `error` (e.g. the person clicked Deny). */
  | { kind: "denied"; error: string; description?: string }
  /** Not our callback: a favicon, a stray request. Answer 404 and keep waiting. */
  | { kind: "ignore" }
  /** Our path, but the state is wrong or the code missing. Stop: something is off. */
  | { kind: "invalid"; reason: string };

export interface CallbackExpectation {
  state: string;
  issuer: string;
  /** The Gateway said it puts `iss` on the callback, so a callback without it is refused. */
  issRequired: boolean;
}

/** Parses a request's method and target (`GET /callback?code=…&state=…&iss=…`). An `iss` that
 * differs from the Gateway's issuer is refused (RFC 9207, mix-up defense), and a missing one too
 * when the Gateway said it sends `iss`. */
export function parseRedirect(
  method: string,
  target: string,
  expected: { state: string; issuer?: string; issRequired?: boolean },
): RedirectOutcome {
  if (method !== "GET") return { kind: "ignore" };
  let url: URL;
  try {
    url = new URL(target, "http://127.0.0.1");
  } catch {
    return { kind: "ignore" };
  }
  if (url.pathname !== CALLBACK_PATH) return { kind: "ignore" };
  const query = new Map<string, string>();
  for (const [k, v] of url.searchParams) if (!query.has(k)) query.set(k, v);
  // A response without our state isn't ours, whatever else it says (RFC 6749 §10.12).
  const state = query.get("state");
  if (state === undefined) return { kind: "invalid", reason: "The sign-in response had no state." };
  if (!constantTimeEqual(state, expected.state)) {
    return { kind: "invalid", reason: "The sign-in response didn't match this sign-in." };
  }
  if (expected.issuer !== undefined) {
    const iss = query.get("iss");
    if (iss !== undefined) {
      if (normalized(iss) !== normalized(expected.issuer)) {
        return { kind: "invalid", reason: "The sign-in response came from a different server." };
      }
    } else if (expected.issRequired) {
      return { kind: "invalid", reason: "The sign-in response didn't say which server sent it." };
    }
  }
  const error = query.get("error");
  if (error !== undefined) return { kind: "denied", error, description: query.get("error_description") };
  const code = query.get("code");
  if (!code) return { kind: "invalid", reason: "The sign-in response had no code." };
  return { kind: "code", code };
}

/** Parses the request line of a raw HTTP head. */
export function parseRedirectHead(head: string, expected: Parameters<typeof parseRedirect>[2]): RedirectOutcome {
  const line = head.split(/\r?\n/, 1)[0] ?? "";
  const [method, target] = line.split(" ");
  if (!method || !target) return { kind: "ignore" };
  return parseRedirect(method, target, expected);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222}
@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}}</style></head>
<body><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div></body></html>`;
}
