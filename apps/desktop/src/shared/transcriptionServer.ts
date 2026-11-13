// A person's own OpenAI-compatible transcription server (Settings → Transcription). When it's
// on, the helper sends meeting audio only there: never to OpenAI, never to Scribe's backend. The
// same address rule as the helper's (mac/Sources/HelperCore/TranscriptionServer.swift), which
// checks it again.

/** What `record.start` and `transcribe.test` take. `apiKey` only when the person set one. */
export interface TranscriptionServerParams {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** `transcribe.test`'s answer: how long one second of silence took, and what came back. */
export interface TranscriptionTestResult {
  ms: number;
  text: string;
  /** Where the audio went: `<base URL>/audio/transcriptions`. */
  endpoint: string;
}

export const MAX_BASE_URL = 2048;
export const MAX_MODEL = 200;
export const MAX_API_KEY = 8192;

/** This Mac or its local network: localhost, `*.localhost`, `*.local` (a Bonjour name, answered
 * on the local link only), `::1`, and the private, link-local and carrier-grade NAT (Tailscale)
 * IPv4 ranges. Trusting the local network with plain http is the point of the setting (a Whisper
 * server on another machine at home). A bare name such as `nas` is not local: a DNS search
 * domain can resolve it anywhere, so it needs https. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.includes(":")) return false;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const n = ip.slice(1).map(Number) as [number, number, number, number];
    if (n.some((part) => part > 255)) return false;
    if (n[0] === 127 || n[0] === 10) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 169 && n[1] === 254) return true;
    if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true;
    return false;
  }
  return false;
}

/**
 * The address a person typed, as a URL string, or null. https to anywhere; plain http only to
 * this Mac or the local network, so audio never crosses the internet unencrypted. Without a
 * scheme, a local host gets http and any other https. No user or password in the URL.
 */
export function parseTranscriptionBaseUrl(text: string): string | null {
  const s = text.trim();
  if (!s || s.length > MAX_BASE_URL) return null;
  const hasScheme = s.includes("://");
  let url: URL;
  try {
    url = new URL(hasScheme ? s : `http://${s}`);
  } catch {
    return null;
  }
  if (!url.hostname || url.username || url.password) return null;
  const local = isLocalHost(url.hostname);
  if (!hasScheme && !local) url.protocol = "https:";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Why a typed address can't be used, for the field. */
export const BASE_URL_HINT = "Use an https address, or http for a server on this Mac or your local network.";
