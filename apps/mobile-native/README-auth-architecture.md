# Native authentication architecture

The native app signs in with the Better Auth Expo client. Better Auth stores the
session cookie in SecureStore, and the app copies that cookie into the native
WebView cookie stores before an embedded app loads. The cookie is scoped to the
gateway hostname so it is sent to app subdomains.

At the gateway perimeter, the cookie authenticates the WebView request. The
perimeter removes the cookie before forwarding the request and mints the
server-side identity JWT used by the app worker. Embedded pages never receive,
store, or handle credentials.

The cookie is synchronized after native sign-in, before a WebView mounts, and
when an open app returns to the foreground. Native sign-out and gateway changes
clear both WebKit and non-WebKit cookie stores.

## Cloudflare Access sign-in

When the gateway offers "Continue with <label>" (Cloudflare Access for SaaS
as an OIDC provider; see `docs/runbooks/cloudflare-access.md`), the sign-in
screen shows it next to, or instead of, the password form. It never runs in
a WebView, and it doesn't use Better Auth Expo's social sign-in: that goes
through the gateway's `/api/auth/expo-authorization-proxy`, which planted
whatever OAuth state it was handed in the browser (any site could finish its
own sign-in in a visitor's browser), so the gateway closes it. Instead
(`src/lib/access-sign-in.ts`, the gateway's `mobile-sign-in.ts`):

1. The app asks the gateway to start (`POST /api/auth/mobile-sign-in/start`)
   and gets a one-time link and a secret. The secret stays in the app's
   memory and never goes through a browser. (The app has no secure random
   source of its own, so the gateway makes it and hands it over on the
   app's own HTTPS request.)
2. The app opens the link in the system browser (`expo-web-browser`'s auth
   session). The gateway starts the Access sign-in in that browser, with
   Better Auth's state cookie and PKCE, so the callback must come back to
   the same browser. A link the app didn't open itself (another site led to
   it, or it opens on another network) asks before it goes on.
3. After Access, the gateway creates the Better Auth session as for any
   Access sign-in, but the browser doesn't keep it: it is sent back to
   `everyapp:///sign-in?code=<one-time code>`, or `?error=<code>` when the
   sign-in was refused, which the screen explains.
4. The app trades the code and its secret for the session
   (`POST /api/auth/mobile-sign-in/finish`). The answer sets the session
   cookie, which the Expo client stores in SecureStore; the app then syncs
   it to the WebView cookie stores as after a password sign-in. A code works
   once, for two minutes, and only with its own sign-in's secret, so a code
   that reaches another app is useless.

Password sign-in doesn't touch any of this. The gateway's side of the flow is
covered by its tests
(`apps/every-app-gateway/src/auth/cloudflare-access/access-sign-in.sqlite.test.ts`)
and the app's by `src/lib/access-sign-in.test.ts`; the app's side has not been
run on a device yet.

Connecting Access to an existing password account (Better Auth's
`linkSocial`) isn't offered in the app: it needs the same browser for the
password session and the Access sign-in. Do it once on the web (account menu
→ Connect <label>); after that, Access alone signs the account in here too.

Cloudflare Access's outer ring (Access in front of the gateway's hostnames)
doesn't work with the app: its native requests carry no Access session, so
Access turns them away. Use OIDC sign-in for teams that use the app.
