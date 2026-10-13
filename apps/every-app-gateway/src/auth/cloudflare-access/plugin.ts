/**
 * The Better Auth plugin that makes Cloudflare Access a way to get a normal
 * Better Auth session. Better Auth stays the system of record (users,
 * sessions, organizations, invitations, tokens, the MCP OAuth server); Access
 * only proves who someone is.
 *
 *  - OIDC sign-in: registers Access for SaaS as the `cloudflare-access`
 *    provider (oidc-provider.ts), used through Better Auth's own
 *    `/sign-in/social` and `/callback/cloudflare-access`.
 *  - Outer ring: when Access sits in front of the gateway's host, a
 *    `/get-session` from a browser without a session (or with someone
 *    else's) that carries a valid `Cf-Access-Jwt-Assertion` signs that
 *    person in, so they never see a second login. A browser signed in as
 *    the same person links the Access identity to their account.
 *  - And behind the outer ring a session cookie counts only with Access's
 *    word for that same person on the request (a verified assertion, from
 *    the header or the `CF_Authorization` cookie browsers send everywhere):
 *    wherever a session is looked up (the perimeter on app hosts, server
 *    functions, the OAuth pages, Better Auth's own endpoints), on any path,
 *    including those Access lets through without a login. So someone taken
 *    out of the Access policy loses the gateway with their Access session,
 *    whatever gateway session their browser still holds. Personal access
 *    tokens and OAuth tokens don't pass through here: deactivation ends
 *    those.
 *  - `GET /api/auth/sign-in-methods`: what the sign-in pages offer.
 *  - The mobile app's OIDC sign-in, handed from the system browser to the
 *    app with a one-time code (mobile-sign-in.ts).
 *
 * Both modes go through Better Auth's `handleOAuthUserInfo`, so linking an
 * Access identity to an existing account follows Better Auth 1.7's rules for
 * trusted providers: the Access email is verified, and the existing
 * account's own email must be verified too (or it was linked while signed
 * in), so an account someone registered with another person's address is
 * never handed to that person. Who may sign in at all is membership.ts.
 */
import type { BetterAuthPlugin, Session, User } from "better-auth";
import { HIDE_METADATA } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  isAPIError,
} from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { parseSessionOutput, parseUserOutput } from "better-auth/db";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { logEvent } from "@every-app/perimeter";
import {
  ACCESS_PROVIDER_ID,
  type AccessConfig,
  type AccessOuterRingConfig,
} from "./config";
import type { AccessIdentity } from "./jwt";
import {
  mobileSignInCallbackHook,
  mobileSignInEndpoints,
} from "./mobile-sign-in";
import { createAccessOidcProvider } from "./oidc-provider";
import { verifyOuterRingAssertion } from "./outer-ring";

interface CloudflareAccessPluginOptions {
  config: AccessConfig;
  /**
   * The gateway's own URL. The outer ring signs people in only on this host,
   * the one Access protects; it is off without it.
   */
  gatewayUrl: string | undefined;
}

/** What the sign-in pages (web and the mobile shell) offer. */
export interface SignInMethods {
  emailPassword: boolean;
  providers: { id: string; label: string }[];
  /**
   * The person Cloudflare Access says this browser belongs to, when the
   * request came through the outer ring.
   */
  accessEmail: string | null;
}

type SessionPair = { session: Session; user: User };

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function requestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).host)
    .trim()
    .toLowerCase();
}

/** A `cookie` header without the cookies called `names`. */
function withoutCookies(headers: Headers, names: string[]): Headers {
  const kept = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      const name = (separator === -1 ? part : part.slice(0, separator)).trim();
      return part && !names.includes(name);
    });
  return new Headers({ cookie: kept.join("; ") });
}

export function cloudflareAccess(options: CloudflareAccessPluginOptions) {
  const { config } = options;
  const gatewayHost = hostOf(options.gatewayUrl);
  const outerRing: AccessOuterRingConfig | null =
    config.outerRing && gatewayHost ? config.outerRing : null;
  const oidcProvider = config.oidc
    ? createAccessOidcProvider(config.oidc)
    : null;

  /**
   * The person the outer ring may sign in on a request to the gateway's
   * host: a verified assertion for the gateway's own Access application.
   */
  async function outerRingIdentity(
    request: Request | undefined,
  ): Promise<AccessIdentity | null> {
    if (!outerRing || !request || requestHost(request) !== gatewayHost) {
      return null;
    }
    const identity = await verifyOuterRingAssertion(request.headers, outerRing);
    return identity?.maySignIn ? identity : null;
  }

  return {
    id: "cloudflare-access",
    init(ctx) {
      return {
        ...(oidcProvider
          ? {
              context: {
                socialProviders: [oidcProvider, ...ctx.socialProviders],
              },
            }
          : {}),
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, hookCtx) {
                  // Loaded on first use, here and below: the membership
                  // policy reads the gateway's database, which the CLI's
                  // schema config (cli-config.ts, run by `auth generate`
                  // outside Workers) can't load.
                  const { accessSignInMode, assertAccessUserMayBeCreated } =
                    await import("./membership");
                  const mode = accessSignInMode(hookCtx);
                  // Behind the outer ring, nothing is made over HTTP for
                  // anyone but the person Access vouches for (below).
                  if (outerRing && mode !== "outer-ring" && hookCtx?.request) {
                    await assertAccessVouchesFor(
                      user.email,
                      hookCtx.request.headers,
                      outerRing,
                    );
                  }
                  if (!mode) return;
                  await assertAccessUserMayBeCreated(user.email, mode, config);
                  return { data: { ...user, emailVerified: true } };
                },
              },
            },
            session: {
              create: {
                async before(session, hookCtx) {
                  const { accessSignInMode, ensureAccessMembership } =
                    await import("./membership");
                  const mode = accessSignInMode(hookCtx);
                  // Behind the outer ring, a session made over HTTP (a
                  // password sign-in, OIDC) would count only for the person
                  // Access vouches for on the request: refuse anyone else's
                  // now, and say why, instead of making one the next request
                  // ignores (or a membership for it). The outer ring's own
                  // sign-in is that person.
                  if (outerRing && mode !== "outer-ring" && hookCtx?.request) {
                    const user =
                      await hookCtx.context.internalAdapter.findUserById(
                        session.userId,
                      );
                    await assertAccessVouchesFor(
                      user?.email ?? null,
                      hookCtx.request.headers,
                      outerRing,
                    );
                  }
                  if (mode) {
                    await ensureAccessMembership(session.userId, mode, config);
                  }
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          // Better Auth's own endpoints over HTTP, but for the session check
          // (below) and signing out: a session Access doesn't vouch for on
          // the request is taken out of it, so they answer as if there were
          // none (a 401 where they need one).
          matcher: (ctx) =>
            outerRing !== null &&
            Boolean(ctx.request) &&
            ctx.path !== "/get-session" &&
            ctx.path !== "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.headers ?? ctx.request?.headers;
            if (!outerRing || !headers) return;
            const { sessionToken, sessionData, dontRememberToken } =
              ctx.context.authCookies;
            const token = await ctx.getSignedCookie(
              sessionToken.name,
              ctx.context.secret,
            );
            if (!token) return;
            const identity = await verifyOuterRingAssertion(headers, outerRing);
            if (identity) {
              const found =
                await ctx.context.internalAdapter.findSession(token);
              if (!found || found.user.email.toLowerCase() === identity.email) {
                return;
              }
            }
            logEvent("access.session_ignored", {
              path: ctx.path,
              reason: identity ? "someone_else" : "no_assertion",
            });
            return {
              context: {
                headers: withoutCookies(headers, [
                  sessionToken.name,
                  sessionData.name,
                  dontRememberToken.name,
                ]),
              },
            };
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => outerRing !== null && ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (isAPIError(returned) || !outerRing) return;
            // The live session get-session answered with (none when it had
            // none, or only an expired one).
            const current = returned
              ? (ctx.context.session as SessionPair | null)
              : null;
            const headers = ctx.request?.headers ?? ctx.headers;
            const identity = headers
              ? await verifyOuterRingAssertion(headers, outerRing)
              : null;

            // Anywhere but the browser's own session check on the gateway's
            // host with the gateway application's assertion (server-side
            // lookups: the perimeter on app hosts, server functions, the
            // OAuth pages; other hosts): a session counts only for the
            // person Access vouches for on this very request, and not at
            // all without an assertion. The browser's next session check on
            // the gateway swaps someone else's.
            if (
              !identity?.maySignIn ||
              ctx.request?.method !== "GET" ||
              requestHost(ctx.request) !== gatewayHost
            ) {
              if (!current) return;
              if (identity?.email === current.user.email.toLowerCase()) return;
              logEvent(
                identity
                  ? "access.session_mismatch"
                  : "access.session_unvouched",
                { userId: current.user.id },
              );
              return ctx.json(null);
            }

            if (
              current &&
              current.user.email.toLowerCase() === identity.email
            ) {
              await linkSignedInAccount(ctx, current.user, identity);
              return;
            }
            if (current) {
              // A session for someone else, in a browser Access says belongs
              // to another person now: end it.
              await ctx.context.internalAdapter.deleteSession(
                current.session.token,
              );
              logEvent("access.session_replaced", {
                userId: current.user.id,
              });
            }

            const signedIn = await signInAccessIdentity(ctx, identity);
            if (!signedIn) {
              if (!current) return;
              deleteSessionCookie(ctx);
              return ctx.json(null);
            }
            await setSessionCookie(ctx, signedIn);
            logEvent("access.signed_in", {
              userId: signedIn.user.id,
              mode: "outer-ring",
            });
            return ctx.json({
              session: parseSessionOutput(
                ctx.context.options,
                signedIn.session,
              ),
              user: parseUserOutput(ctx.context.options, signedIn.user),
            });
          }),
        },
        mobileSignInCallbackHook,
      ],
    },
    // The mobile handoff is a sign-in: Better Auth's own limit for those,
    // per address and endpoint (in production builds).
    rateLimit: [
      {
        pathMatcher: (path) => path.startsWith("/mobile-sign-in/"),
        window: 10,
        max: 3,
      },
    ],
    endpoints: {
      ...mobileSignInEndpoints(oidcProvider),
      signInMethods: createAuthEndpoint(
        "/sign-in-methods",
        { method: "GET", metadata: HIDE_METADATA },
        async (ctx) => {
          const identity = await outerRingIdentity(ctx.request);
          const { isPasswordSignInOn } = await import("./membership");
          ctx.setHeader("cache-control", "no-store");
          const methods: SignInMethods = {
            emailPassword: await isPasswordSignInOn(config),
            providers: config.oidc
              ? [{ id: ACCESS_PROVIDER_ID, label: config.oidc.label }]
              : [],
            accessEmail: identity?.email ?? null,
          };
          return ctx.json(methods);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

type EndpointContext = Parameters<typeof handleOAuthUserInfo>[0];

/**
 * Behind the outer ring, refuse an account or a session for anyone but the
 * person Access vouches for on the request (the sign-in page explains each
 * code).
 */
async function assertAccessVouchesFor(
  email: string | null,
  headers: Headers,
  outerRing: AccessOuterRingConfig,
): Promise<void> {
  const identity = await verifyOuterRingAssertion(headers, outerRing);
  if (!identity) {
    logEvent("access.sign_in_refused", { reason: "no_assertion" });
    throw new APIError("FORBIDDEN", {
      code: "ACCESS_REQUIRED",
      message:
        "This gateway signs people in through Cloudflare Access, and this request didn't come through it.",
    });
  }
  if (email?.trim().toLowerCase() !== identity.email) {
    logEvent("access.sign_in_refused", { reason: "someone_else" });
    throw new APIError("FORBIDDEN", {
      code: "ACCESS_EMAIL_MISMATCH",
      message:
        "Cloudflare Access knows you by another email than this account's, so this browser can't be signed in to it here.",
    });
  }
}

/**
 * Sign an Access identity in the way Better Auth signs in any OAuth user:
 * the account it is linked to, else a linkable existing account, else a new
 * one (each subject to membership.ts). Null when that is refused.
 */
async function signInAccessIdentity(
  ctx: EndpointContext,
  identity: AccessIdentity,
): Promise<SessionPair | null> {
  try {
    const result = await handleOAuthUserInfo(ctx, {
      userInfo: {
        id: identity.email,
        email: identity.email,
        emailVerified: true,
        name: identity.name ?? identity.email.split("@")[0]!,
      },
      account: { providerId: ACCESS_PROVIDER_ID, accountId: identity.email },
      source: {
        method: "oauth",
        oauth: { providerId: ACCESS_PROVIDER_ID, profile: identity.claims },
      },
    });
    if (result.error !== null) {
      logEvent("access.sign_in_refused", {
        mode: "outer-ring",
        reason: result.error.split(" ").join("_"),
      });
      return null;
    }
    return result.data as SessionPair;
  } catch (error) {
    if (!isAPIError(error)) throw error;
    logEvent("access.sign_in_refused", {
      mode: "outer-ring",
      reason:
        (error.body as { code?: string } | undefined)?.code ?? error.status,
    });
    return null;
  }
}

/**
 * Someone signed in (with their password, say) whose browser came through
 * the outer ring as the same email: they have shown they hold both, so link
 * the Access identity to the account. From then on the outer ring signs them
 * in by itself.
 */
async function linkSignedInAccount(
  ctx: EndpointContext,
  user: SessionPair["user"],
  identity: AccessIdentity,
): Promise<void> {
  const adapter = ctx.context.internalAdapter;
  const key = { providerId: ACCESS_PROVIDER_ID, accountId: identity.email };
  if (await adapter.findAccountByKey(key)) return;
  try {
    await adapter.linkAccount({ ...key, userId: user.id });
  } catch (error) {
    // Another request linked it first (one row per identity: migration
    // 0030). The session stands either way.
    logEvent("access.account_link_skipped", {
      userId: user.id,
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    return;
  }
  if (!user.emailVerified) {
    await adapter.updateUser(user.id, { emailVerified: true });
  }
  logEvent("access.account_linked", { userId: user.id, mode: "outer-ring" });
}
