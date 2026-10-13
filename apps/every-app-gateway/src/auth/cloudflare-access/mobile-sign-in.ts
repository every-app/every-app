/**
 * Signing in to the mobile app with Cloudflare Access.
 *
 * The sign-in has to run in the system browser (the identity provider's own
 * page, with the browser's protections and saved logins), but the session is
 * the app's. Better Auth's Expo plugin bridges the two by planting the OAuth
 * state cookie in the browser through `/expo-authorization-proxy`, which
 * plants any state anyone hands it (a login CSRF), so the gateway closes that
 * endpoint (auth/config.ts) and the app uses this handoff instead:
 *
 *  1. The app asks to start (`POST /mobile-sign-in/start`, its own HTTPS
 *     request) and gets a one-time link and a secret. The secret never goes
 *     through a browser: the app has no secure random source of its own, so
 *     the gateway makes it and hands it over on that request.
 *  2. The app opens the link in the system browser
 *     (`GET /mobile-sign-in/continue`), which starts the Access sign-in in
 *     that browser with Better Auth's own state (bound to that browser by its
 *     cookie) and PKCE, so the callback has to come back to the same browser.
 *     A link that another site led to, or that opens on another network than
 *     the app asked from, asks first instead of starting by itself.
 *  3. Better Auth's callback signs the person in as for any Access sign-in
 *     (membership.ts applies), but the browser doesn't keep the session: it
 *     goes back to the app with a one-time code (`everyapp://…?code=`), or
 *     with `?error=` when the sign-in was refused.
 *  4. The app trades the code and its secret for the session
 *     (`POST /mobile-sign-in/finish`), which comes back as the session cookie
 *     the Expo client stores. A code works once, for two minutes, and only
 *     with the secret of the sign-in it came from, so a code that ends up
 *     anywhere else is useless.
 */
import { HIDE_METADATA } from "better-auth";
import {
  addOAuthServerContext,
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";
import { parseSessionOutput, parseUserOutput } from "better-auth/db";
import {
  generateState,
  getOAuthCallbackPath,
  type OAuthProvider,
} from "better-auth/oauth2";
import { evaluateCsrf, logEvent } from "@every-app/perimeter";

/** The app's own scheme: the only place a code is ever sent. */
const APP_SCHEME = "everyapp:";
/** From the app asking to start to the browser opening the link. */
const LINK_TTL_MS = 5 * 60 * 1000;
/** From the callback to the app trading the code. */
const CODE_TTL_MS = 2 * 60 * 1000;
/** Where the sign-in's state says it is for (survives the redirect). */
const SERVER_CONTEXT_KEY = "everyappMobileSignIn";
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

const linkKey = (id: string) => `mobile-sign-in:${id}`;
const codeKey = (codeHash: string) => `mobile-sign-in-code:${codeHash}`;

/** A sign-in the app started, until the browser opens its link. */
interface PendingSignIn {
  secretHash: string;
  redirectURL: string;
  /** The address the app asked from, to tell its own browser apart. */
  ip: string | null;
}

/** A finished sign-in waiting for the app. */
interface Handoff {
  secretHash: string;
  sessionToken: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** An `everyapp:` deep link to send the browser back to, or null. */
function appRedirectURL(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== APP_SCHEME || url.username || url.password || url.hash) {
    return null;
  }
  return url.toString();
}

function clientIp(request: Request | undefined): string | null {
  return request?.headers.get("cf-connecting-ip")?.trim() || null;
}

function parse<T>(value: string, keys: (keyof T)[]): T | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return keys.every((key) => key in parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A plain page for the system browser. */
function page(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937}h1{font-size:1.25rem}p{color:#4b5563;line-height:1.5}button{font:inherit;padding:.6rem 1rem;width:100%}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

const expiredLink = () =>
  page(
    400,
    "This sign-in link has expired",
    "<p>Go back to the Every App app and start signing in again.</p>",
  );

/**
 * Whether the app itself opened this link in the browser: a navigation no
 * other site started (Fetch Metadata `none`, or none at all from an older
 * browser), from the address the app asked from.
 */
function openedByTheApp(request: Request, pending: PendingSignIn): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "none") return false;
  return clientIp(request) === pending.ip;
}

function invalidCode(): APIError {
  return new APIError("BAD_REQUEST", {
    code: "INVALID_MOBILE_SIGN_IN_CODE",
    message: "This sign-in has expired. Please try again.",
  });
}

/** The handoff's endpoints, for the Access OIDC provider (null: off). */
export function mobileSignInEndpoints(provider: OAuthProvider | null) {
  return {
    mobileSignInStart: createAuthEndpoint(
      "/mobile-sign-in/start",
      { method: "POST", metadata: HIDE_METADATA },
      async (ctx) => {
        const body = ctx.body as
          | { provider?: unknown; redirectURL?: unknown }
          | undefined;
        if (!provider || body?.provider !== provider.id) {
          throw new APIError("NOT_FOUND", {
            code: "PROVIDER_NOT_FOUND",
            message: "This gateway doesn't offer that sign-in.",
          });
        }
        const redirectURL = appRedirectURL(body.redirectURL);
        if (!redirectURL) {
          throw new APIError("BAD_REQUEST", {
            code: "INVALID_REDIRECT_URL",
            message: "The app's redirect URL must use the everyapp: scheme.",
          });
        }
        const id = generateRandomString(32);
        const secret = generateRandomString(43);
        const pending: PendingSignIn = {
          secretHash: await sha256(secret),
          redirectURL,
          ip: clientIp(ctx.request),
        };
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: linkKey(id),
          value: JSON.stringify(pending),
          expiresAt: new Date(Date.now() + LINK_TTL_MS),
        });
        ctx.setHeader("cache-control", "no-store");
        return ctx.json({
          url: `${ctx.context.baseURL}/mobile-sign-in/continue?id=${id}`,
          secret,
        });
      },
    ),

    mobileSignInContinue: createAuthEndpoint(
      "/mobile-sign-in/continue",
      {
        method: ["GET", "POST"],
        metadata: {
          ...HIDE_METADATA,
          allowedMediaTypes: [
            "application/x-www-form-urlencoded",
            "application/json",
          ],
        },
      },
      async (ctx) => {
        const request = ctx.request;
        if (!provider || !request) return expiredLink();
        const id =
          ctx.method === "POST"
            ? (ctx.body as { id?: unknown } | undefined)?.id
            : (ctx.query as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string" || !ID_PATTERN.test(id)) {
          return expiredLink();
        }
        const found = await ctx.context.internalAdapter.findVerificationValue(
          linkKey(id),
        );
        const pending =
          found && found.expiresAt > new Date()
            ? parse<PendingSignIn>(found.value, ["secretHash", "redirectURL"])
            : null;
        if (!pending) return expiredLink();

        if (ctx.method === "GET" && !openedByTheApp(request, pending)) {
          // Someone else may have started this sign-in, hoping to get the
          // code for this person's session: ask before going on.
          const label = escapeHtml(provider.name);
          return page(
            200,
            "Sign in to the Every App app?",
            `<p>Continue with ${label} to sign in to the Every App app on this device. If you didn't just start signing in from the app, close this page.</p>
<form method="post" action="${escapeHtml(new URL(request.url).pathname)}"><input type="hidden" name="id" value="${escapeHtml(id)}"><button type="submit">Continue with ${label}</button></form>`,
          );
        }
        // The page's own form, and nothing another site posts. (The page
        // sends no Referer, so browsers send `Origin: null` with it: Fetch
        // Metadata decides, as in the control-plane guard.)
        if (
          ctx.method === "POST" &&
          !evaluateCsrf(
            "POST",
            new URL(ctx.context.baseURL).host,
            request.headers.get("origin"),
            request.headers.get("sec-fetch-site"),
          ).allowed
        ) {
          throw new APIError("FORBIDDEN", {
            code: "INVALID_ORIGIN",
            message: "Continue from the gateway's own page.",
          });
        }

        // One browser per link.
        if (
          !(await ctx.context.internalAdapter.consumeVerificationValue(
            linkKey(id),
          ))
        ) {
          return expiredLink();
        }
        await addOAuthServerContext({
          [SERVER_CONTEXT_KEY]: {
            secretHash: pending.secretHash,
            redirectURL: pending.redirectURL,
          },
        });
        // Where the browser would land if the callback weren't sent back to
        // the app (it always is, below): the gateway's sign-in page.
        const signInPage = `${new URL(ctx.context.baseURL).origin}/sign-in`;
        const { state, codeVerifier } = await generateState({
          ...ctx,
          body: { callbackURL: signInPage, errorCallbackURL: signInPage },
        } as Parameters<typeof generateState>[0]);
        const authorizationURL = await provider.createAuthorizationURL({
          state,
          codeVerifier,
          redirectURI: `${ctx.context.baseURL}${getOAuthCallbackPath(provider)}`,
        });
        throw ctx.redirect(authorizationURL.toString());
      },
    ),

    mobileSignInFinish: createAuthEndpoint(
      "/mobile-sign-in/finish",
      { method: "POST", metadata: HIDE_METADATA },
      async (ctx) => {
        const body = ctx.body as
          | { code?: unknown; secret?: unknown }
          | undefined;
        const code = typeof body?.code === "string" ? body.code : "";
        const secret = typeof body?.secret === "string" ? body.secret : "";
        if (!code || !secret || code.length > 100 || secret.length > 100) {
          throw invalidCode();
        }
        // Consumed whatever happens next: one try per code.
        const row = await ctx.context.internalAdapter.consumeVerificationValue(
          codeKey(await sha256(code)),
        );
        const handoff = row
          ? parse<Handoff>(row.value, ["secretHash", "sessionToken"])
          : null;
        if (
          !handoff ||
          !constantTimeEqual(await sha256(secret), handoff.secretHash)
        ) {
          logEvent("access.mobile_sign_in_refused", {
            reason: handoff ? "secret_mismatch" : "unknown_code",
          });
          throw invalidCode();
        }
        const found = await ctx.context.internalAdapter.findSession(
          handoff.sessionToken,
        );
        // Deactivating someone ends their sessions; this covers a race.
        const { isUserBanned } = await import("@/server/user-ban");
        if (
          !found ||
          found.session.expiresAt < new Date() ||
          isUserBanned(found.user as Parameters<typeof isUserBanned>[0])
        ) {
          throw invalidCode();
        }
        await setSessionCookie(ctx, found);
        ctx.setHeader("cache-control", "no-store");
        logEvent("access.signed_in", {
          userId: found.user.id,
          mode: "oidc-mobile",
        });
        return ctx.json({
          session: parseSessionOutput(ctx.context.options, found.session),
          user: parseUserOutput(ctx.context.options, found.user),
        });
      },
    ),
  };
}

/** The Set-Cookie headers that would leave `names` in the browser, removed. */
function dropCookies(headers: Headers, names: string[]): void {
  const kept = headers
    .getSetCookie()
    .filter(
      (cookie) => !names.includes(cookie.slice(0, cookie.indexOf("=")).trim()),
    );
  headers.delete("set-cookie");
  for (const cookie of kept) headers.append("set-cookie", cookie);
}

/**
 * After Better Auth's OAuth callback for a sign-in the app started: send the
 * browser back to the app with a one-time code for the new session (which
 * the browser doesn't keep), or with the error the sign-in ended in.
 */
export const mobileSignInCallbackHook = {
  matcher: (ctx: { path?: string }) => ctx.path === "/callback/:id",
  handler: createAuthMiddleware(async (ctx) => {
    const state = await getOAuthState();
    const context = state?.serverContext?.[SERVER_CONTEXT_KEY] as
      | Partial<Omit<PendingSignIn, "ip">>
      | undefined;
    const headers = ctx.context.responseHeaders;
    const redirectURL = appRedirectURL(context?.redirectURL);
    if (!context?.secretHash || !redirectURL || !headers) return;

    const back = new URL(redirectURL);
    const signedIn = ctx.context.newSession;
    if (signedIn) {
      const code = generateRandomString(32);
      const handoff: Handoff = {
        secretHash: context.secretHash,
        sessionToken: signedIn.session.token,
      };
      await ctx.context.internalAdapter.createVerificationValue({
        identifier: codeKey(await sha256(code)),
        value: JSON.stringify(handoff),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      back.searchParams.set("code", code);
      const { sessionToken, sessionData, dontRememberToken } =
        ctx.context.authCookies;
      dropCookies(headers, [
        sessionToken.name,
        sessionData.name,
        dontRememberToken.name,
      ]);
    } else {
      const location = headers.get("location");
      let error: string | null = null;
      try {
        error = location
          ? new URL(location, ctx.context.baseURL).searchParams.get("error")
          : null;
      } catch {
        error = null;
      }
      back.searchParams.set("error", error ?? "unknown");
    }
    headers.set("location", back.toString());
  }),
};
