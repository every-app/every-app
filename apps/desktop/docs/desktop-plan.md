# Talk desktop plan (v1: private alpha, macOS)

> **Historical.** This is Talk's plan from 2026-11-02, kept as written; it was made in every-app/private-talk (now every-app/private-open-scribe), where `desktop/`, `mac/` and `packages/ui` were top-level. The app is now **Every App for Mac** in this repository (`apps/desktop`, `apps/desktop/mac`, `apps/desktop/ui`), Talk's meeting notes are its **Scribe** feature, and the names changed (`talk-helper` → `everyapp-helper`, `com.everyapp.talk` → `com.everyapp.desktop`, `talk://record` → `everyapp://scribe/record`, `TalkCore`/`TalkRecording` → `HelperCore`/`HelperRecording`): see `../README.md`. The helper protocol below is still current.

Agreed with Ben on 2026-11-02. Talk becomes a real desktop app. The Mac comes first and Windows comes later. The Every App Worker stays the backend.

## Decisions

| Topic | Decision |
| --- | --- |
| Framework | **Electron + a Swift helper.** The renderer is React and reuses web/'s components. The tested Swift capture and transcription code becomes a headless helper process. Granola is built the same way: Electron plus about 20 small native modules. On Windows, only the helper is replaced (WASAPI loopback). |
| v1 means | **A private alpha** for Ben and the Every team: a signed, notarized DMG with auto-update. |
| Backend | **Every App stays the backend.** The app uses Sign in with Every App, and the Worker + D1 is the source of truth. The web app stays for shared links and browser access. |
| Transcription | **Cloud, as built:** two OpenAI Realtime streams (mic = `me`, system = `them`) using a key the Worker mints. A chunked fallback goes through the Worker. Audio is never stored. |
| Main window | **Built-in UI.** The renderer ships in the app and calls `/api/v1` with the bearer token. It doesn't load the web app's URL. |
| Notes | **Notepad + AI**, like Granola. You jot notes during the call. Afterwards the AI writes the notes from your jottings, the transcript and the template. The live transcript is one click away. |
| Meeting detection | **Calendar reminders + call detection.** Talk asks "Record this call?" when Zoom, Meet, Teams or Slack starts using the mic. It never records without a click. |
| Look | **Calm and native-feeling, like Granola**, built from our own parts: a sidebar, vibrancy, the system font, light and dark modes, using the OpenCRM/OpenSEO components from the web overhaul. A tray icon shows recording state. |
| Signing | **Ben's personal Apple Developer account** (Developer ID + notarization). The credentials go on this Mac through the secret prompt and are never written into the repo. |
| Distribution | **Direct download** with electron-updater. No Mac App Store. |
| Web overhaul | **Finish it and open a PR first.** The desktop app builds on its folders/templates server code and its components. |
| Merging | **The orchestrator merges** into private-talk main after review and green scoped checks. No deploys, releases, public pushes or update-feed uploads without Ben's OK. |

## Architecture

```
┌──────────────────────── Talk.app (Electron) ────────────────────────┐
│ renderer (React, packages/ui)   main (Node)                         │
│  sidebar, meetings, notepad,  ◄─IPC─►  sign-in (PKCE loopback),     │
│  transcript, folders,                  tokens in Keychain           │
│  templates, settings                   (safeStorage), tray,         │
│                                        calendar reminders, updater, │
│                                        helper supervisor            │
│                                             │ JSON lines (stdio)    │
│                         Contents/MacOS/talk-helper (Swift)          │
│                         mic + Core Audio tap, resample, Realtime    │
│                         sockets, segment posting, call detection    │
└─────────────────────────────────────────────────────────────────────┘
        │ HTTPS bearer (/api/v1)                 │ wss, ephemeral key
        ▼                                        ▼
  web/ Worker + D1 (Every App)               OpenAI Realtime
```

- **The helper owns audio and transcription,** using the code already proven in `mac/Sources/TalkCore` and `Recorder`/`RealtimeTranscriber`/`SystemAudioCapture`/`MicCapture`/`ChunkChannel`. It posts segments to the Worker itself and also streams them to the app for the live view. It never stores audio.
- **The main process owns sign-in, tokens, the tray, reminders and updates.** It passes the helper a short-lived access token and refreshes it when the helper asks.
- **TCC:** macOS charges mic and system-audio permission to the app that launched the helper, so `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` go in Talk.app's Info.plist. The helper is signed with the same identity and hardened runtime, and carries `com.apple.security.device.audio-input`.
- **The SwiftUI menu-bar app is retired** (its target, build script and Keychain CLI are removed; an installed `~/Applications/Talk.app` is left for Ben to delete).

### Helper protocol (v1)

Newline-delimited JSON on stdin/stdout, with logs on stderr. Requests carry an `id`, and every request gets exactly one `{ "id", "ok": true, "result" }` or `{ "id", "ok": false, "error": { "code", "message" } }`. Events have no `id`.

| Request `cmd` | Params | Result |
| --- | --- | --- |
| `hello` | `{ protocol: 1 }` | `{ protocol: 1, version, macos }` |
| `permissions.status` | none | `{ mic, systemAudio }`, each `granted`, `denied` or `undetermined` (systemAudio may be `unknown`) |
| `permissions.request` | `{ kind: "mic" \| "systemAudio" }` | the new status |
| `record.start` | `{ meetingId, apiBase, accessToken, language? }` (no voice processing on the mic; an old app's `echoCancellation` is ignored) | `{ startedAt }` |
| `record.stop` | none | `{ segments, finished?, unsaved? }`: posts the last segments and calls `/finish`. Offline, `unsaved` hands back what never posted (`[{ seq, speaker, text, startedMs, endedMs }]`) and `finished` is `false`: the app posts them, then `/finish` |
| `token.update` | `{ accessToken }` | `{}` |
| `detect.set` | `{ enabled }` | `{}` |
| `selftest.run` | `{ seconds?: 1–60 (60) }` | `{ seconds, passed, mic, system }`, each `{ status: "ok" \| "silent" \| "denied" \| "error", peak, sampleRate?, device?, clipping, clippedSamples, dropouts, message? }`. `seconds`: whole seconds heard. `device`: the mic's input device; for `system`, the default output device (where the Mac's sound plays). Captures both sides locally (no network, nothing saved) until `selftest.stop` or `seconds`, streaming `levels` at 10 Hz and `selftest.progress` meanwhile; `busy` while recording, and `record.start` is `busy` during it |
| `selftest.stop` | none | `{ stopped }`: ends a running self-test, whose `selftest.run` then answers with the report so far (`stopped: false` when none ran) |

| Event `event` | Fields |
| --- | --- |
| `state` | `{ recording, meetingId?, mode: "realtime" \| "fallback", mic: "ok" \| "silent" \| "error", system: …, transcription?: "live" \| "reconnecting" \| "catching_up" }` (`catching_up`: audio kept during an outage is being transcribed) |
| `levels` | `{ mic, system }`, 0–1, at most 10 Hz |
| `selftest.progress` | the `selftest.run` report so far: once both captures have started (`seconds: 0`, so the devices show at once), then after each second |
| `transcript.delta` | `{ speaker, text, itemId }` |
| `transcript.segment` | `{ seq, speaker, text, startedMs, endedMs }`. `seq` is a sort key from the turn's start (`startedMs × 4 + them·2 + replayed·1`), unique per meeting, not consecutive: sort by it |
| `token.needed` | `{}`: the app answers with `token.update` |
| `call.started` / `call.ended` | `{ bundleId, appName }`: a known call app started or stopped using the mic |
| `device.changed` | `{ input?, output? }` |
| `error` | `{ code, message, fatal }` |

## Repo layout

- `desktop/`: the Electron app (electron-vite, React 19, Tailwind 4, TanStack Router + Query, electron-builder, electron-updater).
- `mac/`: the Swift package: `TalkCore`, `TalkRecording`, the `talk-helper` executable and the `talk-smoke` API check.
- `packages/ui`: shared components and styles, extracted from web/ after the web overhaul merges. Both web/ and desktop/ use it.
- `web/`: the Worker. `/api/v1` grows to cover what the desktop window needs.

## Lanes

At most 4 child threads run at once. Each has its own worktree and branch, opens a PR into main, and the orchestrator reviews and merges.

| Phase | Lane | Owns | Delivers |
| --- | --- | --- | --- |
| 1 | **W: web overhaul** | `web/` | Finish verifying `t3/verify-web-overhaul-1`: tests, knip, prettier, the remaining browser checks. Then the PR. |
| 1 | **A: desktop shell** | `desktop/` | The Electron app: window + tray, sign-in (Every App OAuth, with a token-paste fallback), Keychain tokens, a helper supervisor that speaks the protocol (with a fake helper for tests), calendar reminders as notifications, electron-builder DMG with the hardened runtime and entitlements, signing and notarizing from env vars, and electron-updater wired but switched off until a feed exists. |
| 1 | **H: Swift helper** | `mac/` | `talk-helper` speaking the protocol, with recording moved out of the SwiftUI app, call detection (Core Audio process input state, plus a list of known call apps), permissions, tests, and a build step that hands Lane A a signed binary. |
| 2 | **API** (after W) | `web/` | Bearer `/api/v1` for folders, templates, jottings (meeting notepad text, used when notes are generated), note editing, a meeting list with filters, and calendar for the window. |
| 2 | **UI** (after A, and API in parallel) | `desktop/src/renderer`, `packages/ui` | Extract `packages/ui`. Build the screens: Home (Coming up + recent), the meeting page (notepad during the call, then notes, with a transcript tab, folder/template chips and share), folders, templates, settings, onboarding (sign-in and permissions). |
| 2–3 | **V: computer-use verification** (Codex) | nothing (reports; fixes go back to the owning lane) | After each phase merges: install `~/Applications/Talk Dev.app` with `pnpm package:local`, sign in against a seeded local `everyapp dev`, click through every screen and flow with Codex computer use, take screenshots in light and dark mode, and report bugs and visual problems. |
| 3 | **Integrate** | everything | Bundle the helper into the app, run an end-to-end recording on the signed build, test an update, and work through the alpha checklist. |

## Milestones to the alpha

| # | Milestone | PRs | State |
| --- | --- | --- | --- |
| M1 | **Foundations** | #1–#14 | done |
| M2 | **Works locally end to end** | #12–#21, Codex passes 1–2 | done |
| M3 | **Desktop features complete** | #15–#48: plus search, offline, updates, e2e CI, outage replay, self-test; Codex pass 3 | done |
| M4 | **Alpha release** (needs Ben) | Developer ID signing + notarization (Ben's credentials; runbook: [docs/release.md](release.md), `scripts/release-mac.sh`), update feed (Ben picks hosting), a real Gateway sign-in test on a deployed Talk (when Ben says go), the alpha checklist, Codex verification pass 2 on the signed build | **waiting on Ben**: Developer ID, R2 bucket + deploy, live test go-ahead (docs/release.md) |

## Local testing and signing

- **No Apple Developer ID is needed to run Talk locally.** Local builds are "Talk Dev" (`com.everyapp.talk.dev`, `~/Applications/Talk Dev.app`), signed with the self-signed "Scrawl Dev" cert (or `TALK_SIGN_ID`). The stable identity keeps mic and system-audio grants across rebuilds.
- **Without a Team ID, the Keychain sign-in is lost on every rebuild.** For local runs, re-paste a token, or use any bearer against local `everyapp dev`.
- **The Developer ID and notarization are only for builds that run on other Macs** and for testing that an update keeps the sign-in.

## Alpha checklist

- [ ] Signed with Ben's Developer ID, notarized and stapled. On a clean user account, first launch shows no warnings.
- [ ] A sign-in survives an app update (Keychain partition = Team ID).
- [ ] Mic + system audio capture and live transcript in a real Zoom/Meet call. Speaker labels are right with headphones on.
- [ ] Notes are generated from jottings, the transcript and the template.
- [ ] A calendar reminder fires and call detection prompts. Nothing records without a click.
- [ ] Sharing works: team visibility, folders and public links.
- [ ] Auto-update from version N to N+1 works.
- [ ] Crash and error logs are readable (`log show`, plus a main-process log file).

## Later

Windows (a WASAPI helper with the same protocol), on-device transcription as an option, speaker names from attendees, search, email sharing.
