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
