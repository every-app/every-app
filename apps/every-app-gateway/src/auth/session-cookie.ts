/**
 * The Better Auth session cookie's names: `better-auth.session_token`, and
 * with the `__Secure-` prefix production builds add (useSecureCookies in
 * auth/config.ts). The cookie cache is off (auth/shared.ts), so this is the
 * only cookie a session is read from. Both names count as one cookie when
 * the gateway refuses a request carrying it twice (cookie tossing,
 * @every-app/perimeter's cookies.ts).
 */
export const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;
