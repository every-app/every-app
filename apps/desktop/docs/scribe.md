# Scribe: the meeting-notes feature and its backend

Scribe is the desktop app's first feature: it reminds you when a meeting starts, records it (system audio plus the microphone), transcribes it live, and its backend turns the transcript into notes with a template you pick. This page is the part of Scribe's spec (from every-app/private-open-scribe's `docs/SPEC.md`, written when Scribe was called Talk) that the desktop app depends on. The backend's data model, web app, folders, templates and sharing are documented in its own repository.

## Architecture

```
Google Calendar ──(held token)──┐
OpenAI (Realtime, chat) ──(key)─┤
                                ▼
                     ┌────────────────────┐
                     │  Every App Gateway  │  sign-in, identity, keys, OAuth
                     └─────────┬──────────┘
                               │ identity JWT / brokered calls
                     ┌─────────▼──────────┐
                     │  Scribe backend     │  meetings, transcripts, notes, sharing,
                     │  (Worker + D1)      │  /api/v1 for the desktop app, update feed
                     │  app id: talk       │
                     └─────────▲──────────┘
       HTTPS, bearer token     │                    ▲  WebSocket, ephemeral key
      ┌────────────────────────┴───────────────┐    │
      │ Every App.app (Electron, apps/desktop)  │    │
      │  renderer: window, notepad, transcript  │    │
      │  main: sign-in, tray, reminders, updates│    │
      │        │ JSON lines over stdio          │    │
      │  everyapp-helper (Swift, mac/): mic +   │────┘ audio straight to OpenAI
      │  system audio, Realtime, segments, call │
      │  detection                              │
      └─────────────────────────────────────────┘
```

- **The Scribe backend** is an Every App app (app id `talk`; TanStack Start on a Worker, D1) in every-app/private-open-scribe's `web/`. It holds all data and every key-bearing call. It serves the browser and `/api/v1`, which the desktop app calls, plus (for now) the private update feed. The desktop names that app id in one place, `src/shared/features.ts`.
- **The desktop app** owns sign-in (tokens encrypted with safeStorage), the tray, calendar reminders, call prompts and updates. It never holds an API key.
- **`everyapp-helper`** (`mac/`) is a headless Swift process inside the app (`Contents/MacOS/everyapp-helper`), driven over stdin/stdout (`desktop-plan.md`, "Helper protocol (v1)"). It captures the mic and system audio, streams them to OpenAI with a short-lived key the backend mints, posts transcript segments to the backend, and watches which apps use the mic to detect calls. TCC charges its capture to the app.
- Audio is never uploaded to the backend and never stored. Only text leaves the Mac.

## Signing in: Sign in with Every App

The person types Scribe's **app URL**, the one they use in the browser (`https://talk.<base>`). The app signs in through the Gateway as an OAuth public client and gets a token bound to that one app. The platform's side is [native sign-in](../../../landing-page/content/agent/native.md).

1. **Discover from the app.** `GET {origin}/.well-known/oauth-protected-resource` names the Gateway (`resource` = the origin, `authorization_servers[0]`). Then `GET {gateway}/.well-known/oauth-authorization-server` gives the authorize, token, revocation and registration endpoints.
2. **Register once per install** as a public client: `token_endpoint_auth_method: "none"`, `redirect_uris: ["http://127.0.0.1/callback"]` (loopback, any port), `client_name: "Every App"`.
3. **Authorize** in the system browser with `code_challenge` (S256), a one-use `state` and `resource={origin}`. No `scope`: the binding is by resource.
4. **Exchange** at the token endpoint with the verifier and the same `resource`: an access token good for an hour and a refresh token (30 days sliding, rotated on use).
5. **Call** `https://talk.<base>/api/v1/...` with `Authorization: Bearer <access token>`. The member who consented is the caller (`chan: "api"`, `act.sub: "oauth:<id>"`). Refresh before expiry or on a 401; `invalid_grant` means sign in again.
6. **Sign out** revokes the refresh token.

The backend lists `/api/v1/**` as a bearer route (`public: [{ path: "/api/v1/**", bearer: true }]`), so behind Cloudflare Access the calls aren't sent to Access's login page.

**Fallback:** a personal access token (Manage workspace → Tokens → New token, bound to the app), pasted into the sign-in screen and sent as `Authorization: Bearer epat_…`. In `everyapp dev`'s stub mode any bearer is the dev user.

## The API the desktop calls

The window and the helper call only `/api/v1` (no server functions). The contract is the backend's `web/src/api/contract.ts`; `src/shared/contract.ts` here is a types-only copy, and `src/main/api/routes.ts` lists the routes the window may call. Every route answers JSON with `cache-control: no-store`; errors are `{ error, message? }`, and a row the caller may not see is 404.

| Route | Does |
| --- | --- |
| `GET /api/v1/me` | `{ user: { id, email, orgName }, google: { connected, connectUrl } }` |
| `GET /api/v1/calendar/upcoming?hours=24` | `{ events: [{ id, title, start, end, attendees, conferenceUrl, location }], connected }`; 409 with `connectUrl` when Google isn't connected |
| `GET/PATCH /api/v1/settings` | the default template |
| `GET/POST /api/v1/meetings`, `GET/PATCH/DELETE /api/v1/meetings/:id` | meetings (list newest first with `folderId`, `shared`, `mine`, `q`, `cursor`, `limit`) |
| `GET /api/v1/search?q&limit&cursor` | full-text search over titles, notes, transcripts and your own jottings |
| `PUT /api/v1/meetings/:id/jottings`, `PUT …/notes` | the notepad (last write wins by `updatedAt`) and edited notes |
| `POST /api/v1/meetings/:id/transcription-token` | `{ value, expiresAt, model, sampleRate }`: an ephemeral OpenAI Realtime key |
| `POST /api/v1/meetings/:id/audio-chunk` | the fallback: a ≤ 30 s WAV, transcribed by the backend, audio dropped |
| `POST /api/v1/meetings/:id/segments` | transcript segments, at most 500 per post; a `seq` already stored is skipped |
| `POST /api/v1/meetings/:id/finish` | stop; the backend writes the notes in the background |
| `POST/DELETE /api/v1/meetings/:id/share…` | public links |
| folders, templates | `GET/POST /api/v1/folders`, `PATCH/DELETE …/:id`, `PUT/DELETE …/:id/meetings/:meetingId`; `GET/POST /api/v1/templates`, `GET/PATCH/DELETE …/:id`, `POST …/:id/duplicate` |

## Meeting reminders and links

1. Every 5 minutes, and on wake, the app asks `/api/v1/calendar/upcoming`. Not connected → it shows "Connect Google Calendar", which opens `connectUrl` in the browser.
2. The lead time (default one minute) before each event that has other attendees or a call link, it notifies: **Join & take notes** (when there's a link) and **Take notes**.
3. A meeting that started without notes gets one nudge in its first minutes. A meeting Scribe is already taking notes for gets neither.
4. `everyapp://scribe/record` (from the Scribe web app) takes notes now; `everyapp://scribe/record?event=<id>&title=…&start=…[&join=1]` takes notes for that event. Any web page can open such a link, so the app starts at once only for an event in its own calendar list, and asks first otherwise. (The web app still opens `talk://record`; it has to move to the new link.)

## Live transcription

1. On start, the app asks the backend for a transcription token; the backend mints an ephemeral OpenAI Realtime key through the Gateway (`gpt-live-transcribe`, PCM 24 kHz, two hours).
2. The helper opens `wss://api.openai.com/v1/realtime?intent=transcription` with that key. Client-side voice detection commits a turn after 600 ms of silence or at 30 s.
3. Two sessions: the microphone (speaker `me`) and system audio (speaker `them`).
4. Segments are posted every ten seconds and on stop. Past 2 hours the helper asks for a new key and reconnects.
5. Finish: the backend writes the notes from the jottings, the transcript and the template.

**Fallback:** when the token route answers `ai_route_not_allowed`, the helper sends 30-second WAV chunks to `/audio-chunk` instead. Near-live, no key on the Mac.

## Permissions (macOS)

| Permission | Why | How |
| --- | --- | --- |
| Microphone | your voice | `NSMicrophoneUsageDescription` ("Scribe transcribes your side of a meeting…") |
| System Audio Recording Only | the other side of the call | a Core Audio process tap, `NSAudioCaptureUsageDescription`; no Screen Recording prompt |
| Notifications | reminders | asked from Settings and onboarding |

The app must be a signed `.app` at a stable path with a stable identity (ad hoc signing loses TCC grants every rebuild), with the hardened runtime and `com.apple.security.device.audio-input`. macOS 15 or later.
