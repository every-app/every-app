# Every App for Mac

The Every App desktop app: a native "everything app" for an Every App workspace. **Scribe** (meeting notes) is its first feature; voice dictation, personal notes and AI features come later as their own sections. Each feature's backend lives in its own repository and is deployed as an Every App app behind the Gateway; this app calls it with a bearer token. Scribe's backend is the app id `talk` (`https://talk.<app base>/api/v1`, in every-app/private-open-scribe).

It's an Electron shell (tray, window, sign-in, calendar prompts, updates) that runs the Swift `everyapp-helper` for audio and transcription. Electron 45, electron-vite, React 19, Tailwind 4, TanStack Query, electron-builder. It's part of the repository's pnpm workspace, with its screens in `ui/` (`@every-app/desktop-ui`) and the helper in `mac/`. Background: [docs/desktop-plan.md](docs/desktop-plan.md) (the original plan and the helper protocol) and [docs/scribe.md](docs/scribe.md) (what Scribe's backend serves the app).

## Run it

From the repository root, `pnpm install` once (it downloads Electron's binary). Then, in `apps/desktop`:

```sh
pnpm dev              # electron-vite dev, with the fake helper unless EVERYAPP_DESKTOP_HELPER_PATH is set
pnpm test             # vitest: PKCE, discovery, redirect parser, refresh/rotation, Access, supervisor, settings, navigation guard, permission probe…
pnpm types:check
pnpm build && pnpm e2e  # Electron e2e smoke: the built app + fake helper against a mock /api/v1 (below)
pnpm package          # an unsigned (ad hoc) release-flavor .app in dist/release/, with the universal helper
pnpm icons            # redraws the app icon (build/icon.icns) and tray icons (macOS: sips, iconutil)
pnpm check:icon       # checks a packaged app's CFBundleIconFile + .icns sizes (default: the .app under dist/)
pnpm package:local    # "Every App Dev" with the real helper: build, sign locally, install, launch (below)
pnpm dist             # release DMG + zip (universal), signed and notarized from env (below)
pnpm release          # scripts/release-mac.sh: the whole release, verified (docs/release.md)
```

`pnpm -C ui test` and `pnpm -C ui playground` cover the screens on their own. The unit tests and type checks run on Linux too (CI runs them in `pr-checks.yml`, the e2e and the Swift helper in `desktop.yml`); the helper, packaging and signing need macOS.

To run Scribe against a local backend, start `everyapp dev` in the Scribe repository's `web/` and sign in with a token ("Signed in against local `everyapp dev`" below).

## Identity: names that never change

Everything that names the app is in [`identity.json`](identity.json), read by main, `electron-builder.config.cjs`, `scripts/package-local.mjs` and `scripts/release-mac.sh`:

| | Release | Dev |
| --- | --- | --- |
| Display name (`productName`) | Every App | Every App Dev |
| Bundle id | `com.everyapp.desktop` | `com.everyapp.desktop.dev` |
| URL scheme | `everyapp://` | `everyapp-dev://` |
| Storage name | `com.everyapp.desktop` | `com.everyapp.desktop.dev` |
| Helper | `Contents/MacOS/everyapp-helper`, `com.everyapp.desktop.helper` | same |
| Release tag | `everyapp-desktop-v<version>` | |

**The display name is the only one that's safe to change.** Local data and the sign-in are pinned to the storage name, not the display name, so a rename can't sign anyone out or lose their data (`src/main/identity.ts`):

- userData: `~/Library/Application Support/com.everyapp.desktop/` (settings, `signin.bin`, pending uploads, prompts);
- logs: `~/Library/Logs/com.everyapp.desktop/`;
- the safeStorage Keychain item: "com.everyapp.desktop Safe Storage". Electron names it after the app's name as it starts, so the packaged `package.json`'s `productName` is the storage name (`extraMetadata` in the builder config), and main sets it again at startup; the display name comes back once the app is ready, for the menus and About.

Changing a bundle id loses the macOS permission grants and makes a different app; changing the scheme breaks the links the web apps open; changing the storage name loses local data and the sign-in. Don't.

There is no migration from Talk for Mac (`com.everyapp.talk`): nobody outside the team had it. Delete `~/Applications/Talk.app` and `Talk Dev.app` by hand.

## Features and their backends

[`src/shared/features.ts`](src/shared/features.ts) lists the features and the backend app id each one calls; nothing else names a backend app id (the Gateway is getting app renames). Today it's Scribe, on `talk`. A new feature adds:

- an entry there (id, label, backend app id);
- a sibling `SidebarSection` in the window's sidebar (`ui/src/screens/AppFrame.tsx`; Scribe's pages sit under "Scribe", Settings and the account stay app-wide);
- its routes in `src/renderer/src/router.tsx`, and its own `everyapp://<feature>/…` links (`src/main/calendar/deepLink.ts` takes `everyapp://scribe/record`).

Sign-in is still one grant, for Scribe's backend: a native token opens one app ([native sign-in](../../landing-page/content/agent/native.md)). A second feature needs a grant of its own; see TODO.md.

Shells that set `ELECTRON_RUN_AS_NODE=1` (some Electron-based terminals do) break Electron. The `dev` and `start` scripts and `package:local` unset it; unset it yourself if you run `electron` by hand.

## Architecture

```
renderer (React, sandboxed, CSP) ──window.everyapp──► preload (contextBridge, typed: src/shared/ipc.ts)
                                                     │ ipcRenderer.invoke / on
main (Node) ─────────────────────────────────────────┘
  auth/      Sign in with Every App (OAuth 2.0 + PKCE, loopback redirect), token paste, safeStorage
  api/       /api/v1 client: bearer, refresh-on-401, Cloudflare Access detection
  helper/    supervisor: spawns everyapp-helper, protocol v1 over stdio, restarts with backoff
  calendar/  polls /calendar/upcoming, prompts 1 min before, "started" nudge, call prompts, everyapp://scribe/record
  recording  creates the meeting, starts/stops the helper, follows its state
  tray, window, updater, ipc (validated), connectivity, pending uploads, log (~/Library/Logs/<app>/main.log, rotating, redacted)
```

- The **renderer** gets data only through `window.everyapp` (`src/shared/ipc.ts`): one typed function per channel, plus `on("state" | "helper")`. Main checks that every call comes from our own page and validates its arguments. Context isolation, the sandbox and `default-src 'none'` CSP are on; webviews and device permissions are refused. `src/main/navigation.ts` guards every webContents: `will-navigate` and `will-redirect` allow only our own page (the bundled `index.html`, or the dev server's origin unpackaged), an https link the page navigates to or `window.open`s goes to the browser, and nothing else is opened. IPC calls are accepted only from that same page, and each channel's arguments are checked in `src/main/ipcValidation.ts`. The pages are in `src/renderer/src/pages/`, routed by TanStack Router (`router.tsx`); the screens they draw are in `ui/`.
- **The helper** speaks [helper protocol v1](../docs/desktop-plan.md#helper-protocol-v1), typed in `src/shared/protocol.ts`. The supervisor says `hello` and refuses another protocol number. It restarts a crashed helper with backoff (1 s, doubling, up to 30 s, reset after 60 s up), answers `token.needed` with `token.update` and a freshly refreshed token, re-sends `detect.set` after a restart, and forwards every event to the renderer. On quit it stops a recording first, then closes the helper's stdin and gives it 10 s (SIGTERM), then SIGKILL after 60 s.
  - Where it is: always the bundled `Contents/MacOS/everyapp-helper` when packaged (the signature and TCC cover that copy). Unpackaged (`pnpm dev`) it's `EVERYAPP_DESKTOP_HELPER_PATH`, else `scripts/fake-helper.mjs`. A `.js`/`.mjs` path runs with Electron as Node.
  - `scripts/fake-helper.mjs` implements the protocol without audio. It fakes a transcript, and like the real helper it posts segments to `{apiBase}/api/v1/meetings/:id/segments` and calls `/finish` on stop, so a fake recording against `everyapp dev` leaves a real meeting behind. Its `FAKE_HELPER_*` knobs (crash, call detection, token.needed, mic denied, protocol number) are listed at the top of the file.
- **Sign-in** is a port of `mac/Sources/HelperCore`: RFC 9728 discovery on the app, then RFC 8414 on the Gateway (`issuer` must match), dynamic registration once per install (re-registered on `invalid_client` or after 50 days unused), PKCE S256, the system browser, a loopback listener on `127.0.0.1:<ephemeral>/callback` that checks `state` and `iss`, and `resource` on authorize/token/refresh with no `scope`. A rotated refresh token is stored before the new access token is used, and concurrent refreshes share one request. `invalid_grant` means signed out. Sign-out revokes the refresh token. The fallback is the app URL plus a personal access token, checked with `/me` before it's kept. If Cloudflare Access answers instead of the app, the app says "Gateway requires Sign in with Every App" and doesn't sign you out.
- **Settings** (`src/main/settings.ts`, `userData/settings.json`): launch at login (`app.setLoginItemSettings`, the SMAppService main-app item; what macOS reports wins at launch, and `loginItem.status` on the snapshot says `requiresApproval` when it wants approval in System Settings, `unsupported` unpackaged), call detection (sends `detect.set` while signed in), the reminder lead time (0–30 min, default 1) and the theme (`nativeTheme.themeSource`). The renderer uses `settings:get` / `settings:set`; every patch is validated in main.
- **Permissions**: `permissions:get` / `permissions:request` / `permissions:openSettings` for `mic`, `systemAudio` and `notifications`. Mic and system audio go through the helper (`permissions.status`, `permissions.request`). macOS can't report the system-audio grant, so `src/main/permissions.ts` watches the helper's `levels`: the first sound on the system channel marks it **verified** (remembered in `userData/permissions.json`); until then it's `unknown`. Only a real helper counts: verification is keyed to the helper binary (path, size, modification time and hello version), the fake helper's levels are ignored, a different helper (a rebuild) starts over, and the tap reporting `system: "error"` takes it back. Notifications: asking shows one notification (macOS prompts the first time); Electron's `show` / `failed` events, from that and from every reminder, record `granted` / `denied`. Statuses are logged to main.log whenever they change.
- **Connection** (`src/main/connectivity.ts`): `connection` on the snapshot is `online`, `offline` or `signin-needed`. Every /api/v1 call reports its outcome: a network failure or a gateway 502/503/504 means offline, while any other answer proves the app is reachable. `net.isOnline()` is polled every 15 s. While offline, main probes `/api/v1/me` with backoff (2 s doubling to 60 s), and a network change or wake from sleep probes at once. A recording keeps running offline: the helper keeps failed segment posts and retries them every 10 s, and save failures aren't shown as a recording error while offline or `signin-needed`.
- **Sign-in expiry**: a refresh refused with `invalid_grant`, or a 401 that survives a refresh, signs out with `auth.expired: true` and keeps `auth.appUrl` and `auth.method`. Cloudflare Access login pages set `auth.needsEveryAppSignIn`. Both make `connection` `signin-needed`, and the window asks to sign in again in place. An expiry doesn't stop a recording: the helper queues segments, asking `token.needed` about every 70 s, and the next sign-in sends `token.update`. Only a sign-out the person chose stops the recording.
- **Unsaved transcript** (`src/main/pending.ts`): when record.stop hands back `unsaved` segments or `finished: false` (the app was unreachable at stop), main keeps them as text in `userData/pending/<meeting>.json` (0600). It replays them when the app is reachable and signed in (at once, on reconnect, or at the next launch): segments in batches of ≤ 50 first (a big insert exceeds D1's SQL-variable limit), then `/finish`. A batch the app refuses for good (a 4xx other than 401, 404, 408, 409 or 429) is dropped and logged rather than retried forever, and the replay goes on to `/finish`. Re-posting is idempotent on seq (time-based since the helper's outage replay: `startedMs × 4 + them·2 + replayed·1`, so not consecutive). A deleted meeting or leftovers older than 14 days are dropped.
- **Audio check** (`src/main/selftest.ts`, for Settings → "Check microphone & Mac audio"): `selftest:run()` runs the helper's `selftest.run` for at most 60 s, and `selftest:stop()` ends it (`selftest.stop`); the run then answers the last report `{ seconds, passed, mic, system }`. It captures both sides locally (nothing sent or saved), with `levels` (10 Hz) and `selftest.progress` (the report so far, each second, with the mic's device and the output device) on the `helper` channel meanwhile. Each side has a `status` of `ok`, `silent`, `denied` or `error`. System audio `denied` only means digital silence, which is also what nothing playing sounds like, so the card only calls a side quiet ("No sound", with Open Settings) after 3 s without sound. The window stops the check when Settings unmounts or the window hides. `selfTest.running` is on the snapshot; it's refused during a recording, and a recording can't start during it (main refuses before creating a meeting, and Start Recording is disabled in the menus). Sound on the system side during a check also marks system audio verified, as a recording would.
- **Transcription outages**: `recording.transcription` follows the helper. `reconnecting` means Realtime is down and the audio is kept, up to 5 minutes per speaker. `catching_up` means that kept audio is being transcribed through the fallback while live audio goes on; then it returns to `live`. A stop waits for that replay before `/finish`, so main allows `record.stop` up to 20 minutes; the helper's own worst case is about 14 minutes, including a 5-minute cap on the replay. Meanwhile the snapshot has `recording.stopping: true` and `recording.stoppingSince` (ISO), so the window can say "Finishing the transcript…" with the elapsed time.
- **Helper crash**: a crash mid-recording calls `/finish` for what was posted and notifies "Recording stopped unexpectedly. Notes are being written from what was captured." The supervisor restarts the helper idle with backoff. `helper.crashes` and the count of recordings cut short appear in diagnostics.
- **Logs** (`src/main/logfile.ts`): `~/Library/Logs/<app>/main.log`, rotating at 5 MB, keeping 3 files, 0600. Every line is redacted (bearer and OAuth tokens, codes in URLs, personal access tokens, JWTs, secret-named fields), and transcript text (`"text": …`) is dropped. The helper's stderr goes in too. Help → **Show Logs** reveals the file. **Copy Diagnostics** copies versions, macOS, connection, sign-in method and app host (no email), settings, helper health and crash counts, recording state (no title), pending uploads and the last 50 log lines.
- **Updates** (`src/main/updates.ts`, only when the build has a feed):
  - Checks in the background at launch and every 6 h while signed in and online, plus Every App → **Check for Updates…** on demand.
  - A downloaded update sets `updater.state: "ready"` on the snapshot, pushes `update: { state: "ready", version }`, and adds **Restart to Update** to the app and tray menus. `update:install` restarts into it.
  - It never restarts during a recording: asking then defers it (`updater.deferred`), and a notification offers it again after Stop.
  - e2e runs use a fake updater (`EVERYAPP_DESKTOP_E2E_FAKE_UPDATE=<version>`, dev builds only).
- **About Every App** shows the app version and the recorder's (from the helper's hello). **Copy Diagnostics** sits right under it in the app menu.
- **Record shortcut** (setting `recordShortcut`, off by default): ⌃⌥⌘R starts or stops a recording from anywhere. If another app holds the keys, `recordShortcut` on the snapshot reads `"conflict"` and Every App leaves them alone.
- **Menus** (`src/main/menu.ts`): the app menu has Settings… (⌘,, which shows the window and sends the `navigate` event `{ to: "settings" }`), the standard Edit menu (copy and paste in text fields), a Recording menu (Start / Stop Recording) and Open Every App in the Window menu. The Dock menu has Open Every App, Start and Stop too, so everything in the tray menu can also be reached without the menu bar's status item. Recording items have no shortcuts; the window owns its own (⌘N).
- **Floating recorder** (setting `floatingRecorder`, on by default; `src/main/pill.ts`, `pillWindow.ts`, `liveTranscript.ts`, page `src/renderer/pill.html`): while a recording is `starting`, `recording` or `stopping`, a small pill (Every App's mark over a level meter, the louder of mic and call audio) sits in the bottom-right corner of the work area of the display it opened on, and moves back there when displays change. It's a non-activating panel (`type: "panel"`, `focusable: false`, `showInactive`), always on top at the `floating` level, on every Space and over full-screen apps, hidden from Mission Control, so it never takes focus from the meeting app. Resting the mouse on it for 150 ms opens the live transcript to its left; it closes 400 ms after the mouse leaves both. Main reads hover by polling the cursor (50 ms) rather than from the page, and the window lets clicks through everywhere except the pill and the open panel. Clicking the pill shows the main window on the meeting. Main keeps the transcript for it from `transcript.delta` / `transcript.segment`: the last 50 finished turns plus the turns in progress, each clipped to 2,000 characters, in memory only, cleared when the recording ends. It reaches the page only while the panel is open (`pill:get`, pushes on `pill` at most every 100 ms); `levels` are forwarded as they come. The page is always dark. Its screens are `FloatingRecorder` in `@every-app/desktop-ui` (playground: "Floating recorder").
- **Recording outcomes**: a stop while `record.start` is still starting is a normal cancel: the helper answers stop with `{ segments: 0, cancelled: true }` and start with error `cancelled`; the app goes back to idle with no error and doesn't `/finish`. A cancelled or failed start deletes the meeting it created (`DELETE /api/v1/meetings/:id`; failures are logged), so no empty or stuck "recording" meeting is left. The non-fatal helper error `fallback_backlog` (the fallback upload fell behind and dropped audio) shows as `recording.warning` (and in the tray menu) while the recording goes on.
- **Reminders**: the app polls `/api/v1/calendar/upcoming` every 5 minutes and on wake. The lead time (default one minute) before each event that has other attendees or a call link, it shows a notification with "Join & take notes" (when there's a link) and "Take notes". A meeting that started without notes gets one nudge in its first 5 minutes. Shown prompts are remembered in `userData/prompts.json` (for a day past each meeting's start), so a restart doesn't prompt again; after a restart, prompts still in Notification Center get their handlers back (`Notification.getHistory`), so clicking one still takes notes. (`Notification.handleActivation` is Windows-only in Electron 45.) The helper's `call.started` brings up "Record this call?". Nothing ever records without a click.
- **`everyapp://scribe/record?event=…&title=…&start=…&join=1`** (`everyapp-dev://` in dev builds; `src/main/calendar/deepLink.ts`): it starts at once only for an event in the app's own upcoming list. Anything else asks first, and the app never opens a link taken from the URL.

## End-to-end smoke

`pnpm build && pnpm e2e` runs `e2e/smoke.spec.ts` with Playwright's `_electron`. It uses the built app (not packaged), the fake helper, and `e2e/mock-api.mjs`, an in-memory `/api/v1` seeded with the `@every-app/desktop-ui` playground data, run as its own process on a free port.

The flows:
- launch signed in through `EVERYAPP_DESKTOP_DEV_*`, with first run shown and then skipped
- Home lists meetings
- open a meeting and switch tabs
- ⌘N, type jottings, the fake transcript appears, Stop (the segments and `/finish` reach the mock)
- reopen the meeting: the jottings are there, on the server too
- a Settings switch persists across a reload (in main's `settings.json`)
- the offline banner while the mock drops connections, cleared once it's back
- an outage backlog of more than 60 segments (the fake helper's burst switch, `FAKE_HELPER_BURST_FILE`) saved once the app is back, with every POST ≤ 50 and then `/finish`; and the same with Stop while still offline, where the helper hands the backlog back and main replays it
- the "new access token" prompt, in place, while the mock answers 401, then signing in again
- an update that "downloaded" (fake updater) is offered in the menu, is deferred during a recording and offered again after Stop
- Help → Reset Onboarding shows first run again

It always uses a temporary `--user-data-dir`, so it never takes the installed Every App Dev's lock or touches its settings or logs (an unpackaged run with that switch keeps its logs in the profile). On failure it keeps a screenshot and a trace in `test-results/e2e`.

CI runs it as the e2e job of `.github/workflows/desktop.yml` on ubuntu-latest under `xvfb-run` and uploads `test-results/` when it fails. The mock also runs alone (`node e2e/mock-api.mjs`, port 8788). `POST /__mock/mode {"mode":"online"|"offline"|"unauthorized"}` switches it, and `GET /__mock/requests` lists what it received, including every segments POST with its size. Like the Worker before its fix, the mock answers 500 "too many SQL variables" to more than 50 segments in one POST (`MOCK_MAX_SEGMENTS_PER_POST`).

## Where tokens live

The sign-in (`{ kind: "oauth", grant }` or `{ kind: "token", appUrl, token }`) and the cached OAuth client ids are one JSON document. It's encrypted with Electron's **`safeStorage`** and written to `~/Library/Application Support/com.everyapp.desktop/signin.bin` (0600, atomically). On macOS, safeStorage keeps its key in the login Keychain as "com.everyapp.desktop Safe Storage" (fixed: see "Identity"), so the secret is still protected by the Keychain, and the file is unreadable without it.

Why safeStorage rather than a keychain module (keytar and friends):

- It has no native module: nothing to rebuild per Electron version or architecture, which keeps the universal build simple. keytar is archived and unmaintained.
- One Keychain item for everything, read once at launch, so there's one Keychain access instead of one per secret.
- It behaves like the Swift app's Keychain items: under a Developer ID the item's partition is the Team ID, so a signed update keeps the sign-in. The alpha checklist item "a sign-in survives an app update" holds.
- If encryption isn't available, nothing is written in plaintext: the app refuses to keep the sign-in.

The cost: a build signed without a Team ID (ad hoc, or a self-signed cert like "Scrawl Dev") can't read the Keychain key written by a differently signed build. The app then says "This build can't read the saved sign-in… Sign in again" instead of failing.

## Local builds without a Developer ID

`pnpm package:local` makes **Every App Dev**, a real packaged app (not `electron .`) for clicking through by hand or with a computer-use agent:

- Bundle id `com.everyapp.desktop.dev`, product name "Every App Dev", URL scheme `everyapp-dev://`, its own userData, logs and Keychain item. It never collides with an installed Every App (`com.everyapp.desktop`, `everyapp://`) in TCC, Launch Services or the Keychain.
- Helper: **the real one by default**, built with `mac/scripts/build-helper.sh` for this Mac's arch only (`EVERYAPP_DESKTOP_HELPER_ARCHS` overrides it). `EVERYAPP_DESKTOP_HELPER_PATH=<binary>` bundles one you already built (e.g. `mac/.build/helper/everyapp-helper`). The fake helper only on request: `EVERYAPP_DESKTOP_FAKE_HELPER=1` (or `EVERYAPP_DESKTOP_HELPER=fake`) bundles a small wrapper that runs it with Electron as Node. The bundled helper is re-signed with the app's identity, keeping its own entitlements and identifier (`com.everyapp.desktop.helper`).
- Signing: `EVERYAPP_DESKTOP_SIGN_ID`, else the self-signed **"Scrawl Dev"** cert if this Mac has it (`security find-identity -v -p codesigning`), else ad hoc. Hardened runtime and `entitlements.dev.plist`. The helper keeps identifier `com.everyapp.desktop.helper`. No notarization.
- It installs to `~/Applications/Every App Dev.app` (quitting a running copy first) and launches it. `EVERYAPP_DESKTOP_NO_LAUNCH=1` skips the launch.

**No Apple Developer ID is needed to run locally.** A stable self-signed cert keeps the microphone and system-audio grants across rebuilds, because TCC matches the bundle id plus the certificate. Ad hoc signing loses them on every rebuild. Dev builds keep sign-ins in memory only (below), so re-paste the token after a relaunch, or use the dev sign-in.

### A fresh profile (first run again)

`EVERYAPP_DESKTOP_DEV_FRESH=1 pnpm package:local` (or `EVERYAPP_DESKTOP_DEV_FRESH=1` in the environment of any dev-build launch, `pnpm dev` included) starts Every App Dev on a brand-new, throwaway profile. Onboarding shows, and there are no settings and no sign-in; paste a token in the sign-in screen. It lives in the temp dir as `everyapp-dev-fresh-*` and is deleted on quit; leftovers from a crashed run are swept at the next fresh start. The normal Every App Dev profile isn't read or written, and `package:local` writes no dev sign-in in this mode. Logs still go to `~/Library/Logs/com.everyapp.desktop.dev`. Release builds ignore it.

Dev builds also have Help → **Reset Onboarding**, which clears only the onboarding-seen flag and reloads the window.

### Signed in against local `everyapp dev`

`everyapp dev` runs the Worker in stub mode, where any bearer is the dev user, so a token sign-in with the local URL is enough:

```sh
# in the Scribe repository's web/: everyapp dev  (seed it as you like), then here:
EVERYAPP_DESKTOP_DEV_APP_URL=http://talk.localhost:8787 EVERYAPP_DESKTOP_DEV_TOKEN=dev pnpm package:local
# the same with the fake helper (no audio, a made-up transcript):
EVERYAPP_DESKTOP_FAKE_HELPER=1 EVERYAPP_DESKTOP_DEV_APP_URL=http://talk.localhost:8787 EVERYAPP_DESKTOP_DEV_TOKEN=dev pnpm package:local
# or, unpackaged:
EVERYAPP_DESKTOP_DEV_APP_URL=http://talk.localhost:8787 EVERYAPP_DESKTOP_DEV_TOKEN=dev pnpm dev
```

`package:local` writes `~/Library/Application Support/com.everyapp.desktop.dev/dev-signin.json`. **Dev builds never touch safeStorage**: a rebuilt Every App Dev can't open the last build's "com.everyapp.desktop.dev Safe Storage" item, and macOS would otherwise show a Keychain password dialog (blocking launch) that stops a computer-use tester. Every dev sign-in, pasted token or OAuth, lasts until quit. `EVERYAPP_DESKTOP_DEV_KEYCHAIN=1` opts back in to test the stored sign-in (ignored while a dev sign-in or `EVERYAPP_DESKTOP_DEV_NO_KEYCHAIN=1` is in use). The app reads that file, or the env vars, at launch and signs in with the token **in memory only** (it never stores it, so rebuilds don't matter). Only dev builds read it: unpackaged, or the "Every App Dev" product. Plain `http://` is accepted only for `localhost`, `*.localhost` and `127.0.0.1`. You can also paste the URL and any token in the sign-in screen ("Use an access token instead").

## Release builds: signing, notarization, updates

`pnpm dist` reads everything from the environment:

| What | Env |
| --- | --- |
| Signing identity | `CSC_NAME` (a Keychain identity, e.g. "Developer ID Application: …") or `CSC_LINK` + `CSC_KEY_PASSWORD` (a .p12). None set: ad hoc. |
| Notarization | `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`. Only with a signing identity. None set: skipped. |
| Helper | Always the real, universal one: `scripts/release-helper.mjs` checks `EVERYAPP_DESKTOP_HELPER_BINARY` or builds `mac/.build/helper/everyapp-helper` for arm64 + x86_64, and the builder config refuses a release with a missing or single-arch helper. electron-builder re-signs it with the app's identity. |
| Update feed | `EVERYAPP_DESKTOP_UPDATE_URL` (generic provider), the one setting that names the feed. Unset: no `app-update.yml` is written, and updates (and their menu items) stay off. Today the feed is still Scribe's backend (`https://talk.<base>/api/v1/updates/mac/`; where it should move: docs/release.md, "Update feed"). A feed on the signed-in Scribe backend's own https origin gets the API's bearer on each check and the download it triggers, refreshed once after a 401, and the check is skipped while signed out. A feed on any other host gets no credentials (`src/main/updateAuth.ts`). |

The DMG and zip are universal (arm64 + x64), with the hardened runtime and `build/entitlements.mac.plist` (JIT, unsigned executable memory, `com.apple.security.device.audio-input`). Info.plist carries `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` (TCC charges the helper's capture to Every App.app), `everyapp://` and macOS 15 as the minimum. An `afterPack` hook removes the camera and Bluetooth usage strings Electron's template adds, so only the mic and audio capture are asked for. Release fuses turn off RunAsNode, `NODE_OPTIONS` and the inspector flags, and turn on asar integrity and asar-only loading. The app icon is `build/icon.icns`, drawn from `build/icon.svg` by `pnpm icons`.

## Files

| Path | What |
| --- | --- |
| `identity.json` | the app's fixed names (above) |
| `src/shared/` | `features.ts` (features and their backend app ids), `protocol.ts` (helper protocol v1), `ipc.ts` (the bridge's types), `api.ts` (API shapes + lenient decoders), `contract.ts` (a types-only copy of Scribe's `/api/v1` contract) |
| `src/main/` | `index.ts` (wiring), `menu.ts` (app and Dock menus), `auth/`, `api/`, `helper/`, `calendar/`, `recording.ts`, `tray.ts`, `window.ts`, `updater.ts`, `ipc.ts` + `ipcValidation.ts`, `navigation.ts`, `settings.ts`, `permissions.ts`, `system.ts` (login item, theme, System Settings links, notification permission), `connectivity.ts`, `pending.ts`, `diagnostics.ts`, `updateAuth.ts`, `identity.ts` (flavor, pinned storage), `config.ts`, `log.ts` + `logfile.ts` |
| `src/preload/` | the `window.everyapp` bridge |
| `src/renderer/` | the window (`index.html`) and the floating recorder (`pill.html`, `src/pill/`) |
| `ui/` | `@every-app/desktop-ui`: the screens, components and a playground (`ui/README.md`) |
| `mac/` | the Swift package for `everyapp-helper` (`mac/README.md`) |
| `docs/` | `release.md` (signing, notarizing, the update feed), `desktop-plan.md` (the original plan, the helper protocol), `scribe.md` (Scribe's backend and its contract with this app) |
| `scripts/` | `release-mac.sh` (a whole release), `fake-helper.mjs`, `package-local.mjs`, `release-helper.mjs` (the universal helper for releases), `make-icons.mjs` (draws `build/icon.{svg,icns}` and `resources/tray/*Template.png`) |
| `build/` | entitlements, the app icon |
| `test/` | vitest suites and `fakeServer.ts` (a fake Scribe app + Gateway) |
