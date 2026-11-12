/**
 * The pages the perimeter answers a person with when it refuses a page
 * load: a browser shows a JSON refusal as raw text, which tells nobody
 * what to do. Scripts keep the JSON (gateway.ts picks by `Accept`), and
 * the status is the same either way.
 *
 * Static HTML with inline CSS and no script, under a CSP that allows
 * nothing else; every value is escaped. A page names the app and its
 * organization only to someone signed in to that organization. Anyone
 * else reads the host they typed and nothing the JSON doesn't already say.
 */
import { withSecurityHeaders } from "./headers";

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STYLE = [
  ":root{color-scheme:light dark}",
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937;background:#fff}",
  "h1{font-size:1.25rem;margin:0 0 1rem}",
  "p{color:#4b5563;line-height:1.5;margin:0 0 .75rem}",
  "strong{color:#1f2937;font-weight:600}",
  "a{color:#1d4ed8}",
  ".next{margin-top:1.5rem}",
  "@media (prefers-color-scheme:dark){body{color:#f3f4f6;background:#111827}p{color:#9ca3af}strong{color:#f3f4f6}a{color:#93c5fd}}",
].join("");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(status: number, title: string, body: string): Response {
  return withSecurityHeaders(
    new Response(
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
      {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": PAGE_CSP,
        },
      },
    ),
    { noStore: true },
  );
}

export interface NoAppAccessPageInput {
  /** The signed-in account's email. */
  email: string;
  /** The host the person asked for. */
  host: string;
  /**
   * The app's name and its organization's, given only when the person is
   * signed in to that organization.
   */
  named?: { appName: string; organizationName?: string };
  /** The launcher, where the person's own apps and Sign out are. */
  launcherUrl?: string;
}

/** 403: signed in, and this account can't open the app. */
export function noAppAccessPage(input: NoAppAccessPageInput): Response {
  const app = input.named
    ? escapeHtml(input.named.appName)
    : `the app at ${escapeHtml(input.host)}`;
  const title = input.named
    ? `You can't open ${input.named.appName}`
    : "You can't open this app";
  const organization = input.named?.organizationName
    ? `<strong>${escapeHtml(input.named.organizationName)}</strong>`
    : "its workspace";
  const launcher = input.launcherUrl
    ? `<p class="next"><a href="${escapeHtml(input.launcherUrl)}">Go to your apps</a></p>` +
      "<p>To use another account, sign out there and sign in again.</p>"
    : "";
  return page(
    403,
    title,
    `<p>You're signed in as <strong>${escapeHtml(input.email)}</strong>. This account doesn't have access to ${app}.</p>` +
      `<p>Ask an owner or admin of ${organization} to give you access.</p>` +
      launcher,
  );
}

/** 403: a server function's address opened as a page (a link or a redirect). */
export function notAPagePage(): Response {
  return page(
    403,
    "This address isn't a page",
    "<p>It is one the app calls for itself, so it doesn't open in a browser.</p>" +
      '<p class="next"><a href="/">Open the app</a></p>',
  );
}
