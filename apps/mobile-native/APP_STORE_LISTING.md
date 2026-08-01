# App Store Listing — Every App Gateway

Working document for App Store Connect metadata. Iterate here before pasting into ASC.

---

## Version-Level Info

### App Name

Every App Gateway

### Subtitle (max 30 chars)

Manage and access your self hosted apps.

### Keywords (max 100 chars, comma-separated)

self-hosted,open-source, opensource, cloudflare, tools

### Promotional Text (max 170 chars, editable anytime without re-review)

No subscriptions, 100% open source. Manage and access your apps self hosted on Cloudflare.

### Description (max 4000 chars)

Every App Gateway is a personal dashboard for accessing your self-hosted web apps.

Sign in once to your Gateway account and securely open the apps you already run on your own Cloudflare infrastructure — all from a single place.

How it works:

- Sign in with your Gateway account
- See apps your account is authorized to access
- Open any app in a secure, managed session
- Switch between apps without re-authenticating

Built for developers:
Every App is an open source platform for building and self-hosting personal software on Cloudflare. Build apps with your favorite coding agent, deploy with one CLI command, and access everything from this companion app.

Features:

- Native sign-in with secure credential storage
- Managed sessions with automatic token refresh

This app connects to your own Every App Gateway deployment. You need an existing Gateway account to sign in. Learn more at everyapp.dev.

### What's New (for v1.0.0)

Initial release. Sign in to your Every App Gateway and access your self-hosted apps from one place.

### Copyright

2026 Ben Senescu

### Price

Free

### Primary Category

Developer Tools

### Secondary Category

Utilities

### Screenshots Plan

The goal is to tell a story: sign in → see your apps → use real apps → show variety.
Each screenshot should feel like a real person's setup, not a marketing mock.
Up to 10 screenshots allowed per device size.

Required sizes:

- iPhone 6.7" — 1290 x 2796 px (required)
- iPhone 6.5" — 1284 x 2778 px (required)
- iPad (if claiming tablet support) — 2048 x 2732 px

---

## App Review Notes

```
Every App Gateway is a companion app for a user's own self-hosted
applications. Users sign in once, then open apps they already host on
their own Cloudflare deployment.

How to test:
1. Launch the app and enter Gateway URL:
   https://every-app-gateway.app-store-review.workers.dev/
2. Sign in with the reviewer account:
   [EMAIL] / [PASSWORD]
3. Open the listed apps and verify normal usage. You can add a todo or
   complete part of a workout.

Notes:
- This is not a public app marketplace.
- The app does not provide arbitrary web browsing.
- Users only access apps that are already deployed and authorized in their
  own Gateway instance.
```

Use this short version for first submission. If rejected for clarification,
reply in Resolution Center with the longer architecture/security explanation.

### Age Rating Questionnaire Notes

- No violent, sexual, or mature content
- No gambling or contests
- No unrestricted web access (WebView is origin-restricted)
- Suggested rating: 4+

### Privacy Nutrition Labels

| Data Type                               | Collected?                              | Linked to Identity? | Used for Tracking? |
| --------------------------------------- | --------------------------------------- | ------------------- | ------------------ |
| Email Address                           | Yes                                     | Yes                 | No                 |
| Password                                | Yes (transmitted, not stored on device) | No                  | No                 |
| User ID                                 | Yes                                     | Yes                 | No                 |
| Product Interaction (which apps opened) | Yes                                     | Yes                 | No                 |
| Authentication Tokens                   | Yes (stored in Keychain)                | Yes                 | No                 |

Purpose: App Functionality

### Account Deletion

Not applicable. Every App Gateway does not store user accounts — accounts
are created and managed entirely on the user's own self-hosted Gateway
deployment. The app is a client that connects to the user's server. The
user controls their own data and infrastructure.

If Apple requires an account deletion mechanism, the argument is:

- This app is a client for a self-hosted server the user already controls
- The user can delete their account directly on their own server
- This is analogous to an SSH client or database admin tool — the client
  doesn't manage the server's user accounts

---

## Open Items

- [ ] Create demo account with pre-loaded apps for Apple reviewer
- [ ] Generate screenshots at required sizes
- [x] Publish privacy policy at a public URL (everyapp.dev/privacy)
- [x] Publish support page at a public URL (everyapp.dev/support)
- [x] Finalize app icon (1024x1024, no alpha channel)
