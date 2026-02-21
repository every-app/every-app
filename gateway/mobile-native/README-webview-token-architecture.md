# WebView Token Bridge Architecture

This document describes the security model for embedded apps inside the native
WebView wrapper.

## Goals

- Prevent cross-app token theft (for example: app A asking for app B token).
- Avoid trusting web-originated token request payloads.
- Only deliver tokens to pages loaded from allowlisted origins.

## High-level flow

1. Native shell selects the app context (`appId`, `appUrl`, optional `devUrl`).
2. Native WebView loads the target URL for that app.
3. Native bridge mints a session token using the native-selected app context.
4. Native bridge pushes token updates into the page via injected `message`
   events (`SESSION_TOKEN_UPDATE`).
5. Embedded SDK consumes pushed token updates and uses them for API requests.

The embedded website does **not** trigger token issuance by sending a token
request message to native.
Native WebView does not register a web->native message handler for token flows.

## Security boundaries

### 1) Push-only token model

Native no longer issues tokens in response to `window.ReactNativeWebView.postMessage`
requests. This removes the spoofable input channel (`appId`, `requestId`) from
token minting decisions.

### 2) Native-owned app context

Token issuance always uses app metadata selected in native UI, never values from
web messages.

### 3) URL allowlist enforcement

Before route updates and top-level navigations are accepted, URLs are validated
against the selected app's currently active mode origin (prod origin in prod
mode, dev origin in dev mode). Unexpected origins are blocked.

### 4) Server-side enforcement remains

`/api/session-token` continues validating user access and app/origin mapping.
This remains a critical defense-in-depth layer.

## Why this is safer than request/response messaging

In React Native WebView, native `onMessage` callbacks do not provide browser-style,
cryptographically trustworthy sender origin semantics equivalent to iframe
`postMessage` checks. The push-only model minimizes trust in web-originated data
for sensitive actions.

## Remaining risks

- If the allowlisted website itself is compromised (for example, XSS), pushed
  tokens can still be stolen by that origin.
- This architecture reduces cross-app spoofing risk but does not replace secure
  app frontend practices.

## Key files

- `gateway/mobile-native/src/hooks/useWebViewBridge.ts`
- `gateway/mobile-native/app/apps/[appId].tsx`
- `packages/sdk/src/core/sessionManager.ts`
