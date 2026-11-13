# Every App for Mac: the Swift side

Every App for Mac is the Electron app one level up, in `apps/desktop` (../README.md). This Swift package holds what stays native: **`everyapp-helper`**, the headless process the app spawns for audio capture and transcription, and the code it's built from. macOS 15+, SwiftPM only (no Xcode project).

```sh
./scripts/test.sh              # unit tests (Swift Testing; works with only the Command Line Tools)
./scripts/build-helper.sh      # release everyapp-helper, universal + signed → .build/helper/everyapp-helper
swift run everyapp-smoke http://talk.localhost:8787 any-token   # the API client against a running Scribe backend (the Scribe repository's web/)
```

The package's modules were Talk's (`TalkCore`, `TalkRecording`, `talk-helper`); they're `HelperCore`, `HelperRecording` and `everyapp-helper` now. The old SwiftUI menu-bar Talk app is retired: an installed `~/Applications/Talk.app` is left on disk to delete by hand.

## Layout

| Path | What |
| --- | --- |
| `Sources/HelperCore` | No hardware, all tested: the API client (`/api/v1`, bearer, refresh-on-401 through `AuthProvider`, Cloudflare Access detection, lenient decoders), `SegmentBatcher`, `EchoDedupe`/`EchoFilter`, `ChunkCutter`, `Resampler` (windowed sinc) and PCM16, `TurnDetector`, WAV |
| `Sources/HelperRecording` | Recording without UI or Keychain: `MicCapture` (AVAudioEngine; voice processing only for `--selftest --echo-cancellation`), `SystemAudioCapture` (Core Audio process tap), `RealtimeSession`/`TranscriptionChannel`, `ChunkChannel` (fallback), `OwnServerChannel` (the person's own transcription server), `RecordingPipeline` (channels, capture, echo filter, 10 s posting, `/finish`, levels), `CallDetection`, `AudioDevices`, and the helper protocol (`Helper/`: codec, `HelperAuth`, `HelperServer`, `RequestTracker`) |
| `Sources/everyapp-helper` | The helper's `main`: stdin/stdout, signals, device-change watcher |
| `Sources/everyapp-smoke` | The API smoke (below) |
| `Tests/HelperCoreTests`, `Tests/HelperRecordingTests` | The above, with fake capture, channels, Worker and process source |
| `Resources` | The helper's embedded Info.plist and entitlements (used by `build-helper.sh`) |

Sign-in, reminders, `everyapp://` links and the menu live in the Electron app (TypeScript), not here.

## everyapp-smoke

Drives the API client through a meeting against a running Scribe with a bearer token: `me`, `upcoming`, create, transcription token and audio chunk (both need OpenAI set up), segments (twice, to check dedupe), `/finish`, the meetings list. No audio, no Keychain.

```sh
swift run everyapp-smoke http://talk.localhost:8787 any-token          # everyapp dev: any bearer is the dev user
EVERYAPP_DESKTOP_TOKEN=epat_… swift run everyapp-smoke https://talk.<base>          # a personal access token, kept out of shell history
swift run everyapp-smoke https://talk.<base> --token-file ~/.talk-token
```

## Self-test (no account, no network)

```sh
.build/helper/everyapp-helper --selftest                       # 8 s; speak, and play a video through the speakers
.build/helper/everyapp-helper --selftest --seconds 15 --echo-cancellation
```

It captures the mic and system audio locally (no Realtime, no Worker; nothing recorded, uploaded or written anywhere), prints the devices and a level line per second, then a summary per side: `OK` (a peak above −45 dBFS), `SILENT` (signal, but too quiet), `DENIED` (mic permission off; for system audio, only digital silence, which is what a tap without permission delivers, or what you get when nothing plays), or `ERROR` (it couldn't start), plus clipping (> 0.1 % of samples at full scale), dropouts (a second, after the first, that delivered under 0.7 s of audio), sample rates and whether voice processing is on. Exit code 0 when both sides are OK with no dropouts. Run from a terminal, the mic and system-audio prompts are for the terminal app; inside Every App.app (`selftest.run`) they're Every App's. Permissions go through the usual paths (the mic is asked if never asked; the tap starting is what makes macOS ask for system audio).

`--echo-cancellation` (Apple's voice processing on the mic) is only reachable here, kept for a future hardware test; recordings and the app never turn it on.

The same check is the request `selftest.run { seconds? }` (default 60; docs/desktop-plan.md), for Settings → "Check microphone & Mac audio": it streams `levels` and `selftest.progress` (the summary so far, with the input and output device names) until `selftest.stop` or `seconds`, then answers the summary.

## Recording

Mic and system audio are converted to PCM16 24 kHz mono on the Mac and streamed to two OpenAI Realtime transcription sockets (`me`, `them`), each with its own ephemeral key from `POST /api/v1/meetings/:id/transcription-token`. Turns are detected on the Mac (600 ms of silence or 30 s, Scrawl's rule). Finished segments are posted every 10 s and on stop (at most 50 per request, oldest first; a failure stops that round so seqs post in order, and the rest waits for the next tick), and the meeting is finished on stop. **On stop the turn in progress is kept:** capture stops and every buffered chunk reaches its channel; each Realtime channel commits the open turn (`input_audio_buffer.commit`) and waits up to 3 s for its `completed`; a turn still unfinished then is saved with its text so far (its deltas) rather than dropped. In fallback mode the last partial chunk is cut and sent. Then the final flush and `/finish`. A 4xx a retry won't change (anything but 401, 408, 409, 429) isn't retried: those segments are set aside and handed back in `record.stop`'s `unsaved`. If the token route reports live keys unavailable (`ai_route_not_allowed`, or a 403/501/502/503 other than `ai_provider_not_configured`), both speakers switch to the fallback: chunks of up to 30 s, cut at a turn's end once 20 s have gathered (and silence dropped), are posted to `POST …/audio-chunk` as in-memory WAVs. Audio is never written to disk.

**The person's own transcription server.** When `record.start` carries `transcription` (`{ baseUrl, model, apiKey? }`; Settings → Transcription, `../docs/scribe.md`), the recording runs in mode `custom`: no Realtime key is fetched, and each speaker gets an `OwnServerChannel`, which cuts chunks as the fallback does and posts each as a 16 kHz WAV to `<baseUrl>/audio/transcriptions` (`TranscriptionServerClient`: `file`, `model`, `response_format=json`, `language`; a bearer only with a key; redirects not followed). The text comes back as a finished turn, so it takes the usual path: echo check, `/segments` every 10 s, `/finish`. The audio goes nowhere else: the pipeline never builds a Realtime channel or replays through `/audio-chunk` in this mode. The start checks the server (8 s at most): a refusal or nothing listening fails `record.start` with `transcription_server`; a slow or busy one records anyway. While the server doesn't answer, chunks wait in memory (`OutageBuffer`'s size, about 5 minutes of speech per speaker), the same chunk is retried (2, 4, … at most 15 s apart) and `state.transcription` is `reconnecting`; past the limit the oldest waiting chunk goes, with one `fallback_backlog` warning. A chunk the server refuses (a 4xx other than 408, 409, 425, 429) isn't retried. On stop, a chunk gets two more tries, then it and everything behind it are given up and the stop says how much (`save_failed`).

**Outages.** While a speaker's Realtime connection is down (backoff 1, 3, 10, then 30 s), that speaker's audio is kept in memory (`OutageBuffer`, at most 5 minutes ≈ 14 MB per speaker; past that the oldest goes, with one `fallback_backlog` warning). When the connection is back, or when the recording stops first, the kept audio is transcribed through the fallback (`/audio-chunk`, cut at turn ends, ≤ 30 s chunks) while live audio goes on to Realtime. Its segments get replay seqs from their real start times, so they land in place in the transcript. `state.transcription` is `catching_up` meanwhile. The replay's queue holds the whole outage (it isn't subject to the live fallback's 8 MB / 3-minute backlog limits). Stop waits for the replay before `/finish` (the Worker only takes chunks while the meeting records), but **at most 5 minutes** (`replayStopBudget`); then it cancels what's left and says so (`save_failed`). A whole `record.stop` is therefore bounded at about 13–14 minutes in the worst case: channels finishing (≤ 25 s), the replay budget (5 min), the final segment posts (3 tries, ≤ ~6 min with a 60 s token wait), and `/finish` (≤ 2 min). a stretch that still can't be transcribed after 3 tries is reported (`transcription` error, and `save_failed` with the stop), since audio is never kept anywhere to hand back. While `them` is reconnecting or catching up, `me` segments wait for the echo check instead of being judged against an incomplete other side; replayed `them` text counts for it. Replayed `me` text is stored by the Worker as it comes, so it isn't echo-checked.

## Signing and permissions

- TCC charges the helper's mic and system-audio use to the app that launched it (Every App.app, or Every App Dev.app), whose Info.plist carries the usage strings; grants follow that app's bundle id and certificate. A stable certificate (a Developer ID, or the self-signed "Scrawl Dev" locally) keeps them across rebuilds; ad hoc loses them.
- Permissions are asked by the app (through `permissions.request`) or right before a recording starts, never from inside capture code. System audio has no ask/check API: macOS prompts the first time a process tap starts.

## everyapp-helper

A headless executable (no UI, no Keychain, no sign-in) that the Electron app's main process spawns and drives over stdin/stdout with newline-delimited JSON: **protocol v1, as specified in docs/desktop-plan.md "Helper protocol (v1)"**. stdout carries protocol lines only; logs go to stderr and os_log (subsystem `com.everyapp.desktop`, category `helper`; never tokens). It exits cleanly when stdin closes or on SIGTERM/SIGINT: a recording is stopped properly first (last segments posted, `/finish` called; a `record.stop` already in progress is waited for, and a start still on the mic prompt or fetching keys is cancelled). Other requests get 250 ms to answer; one stuck on a permission prompt doesn't hold the exit. Idle, it exits in about 30 ms; a 45 s watchdog bounds the recording case.

```sh
./scripts/build-helper.sh        # release, universal (arm64 + x86_64), signed → .build/helper/everyapp-helper
printf '{"id":1,"cmd":"hello","params":{"protocol":1}}\n{"id":2,"cmd":"permissions.status"}\n' | .build/helper/everyapp-helper
```

**For packaging (Lane A):** copy `mac/.build/helper/everyapp-helper` to `Every App.app/Contents/MacOS/everyapp-helper`. The script prints that path as its last stdout line. It signs with `EVERYAPP_DESKTOP_SIGN_ID` if set (use the app's Developer ID; then a secure timestamp is added), else the self-signed "Scrawl Dev" cert if the keychain has it (a stable identity, so TCC grants survive rebuilds), else ad hoc. Always hardened runtime, entitlement `com.apple.security.device.audio-input`, identifier `com.everyapp.desktop.helper`, with `Resources/helper-Info.plist` embedded in `__TEXT,__info_plist`. No notarization here: the app is notarized as a whole (re-sign the helper with the app's identity if electron-builder doesn't). `EVERYAPP_DESKTOP_HELPER_ARCHS=arm64` builds one slice.

**TCC charges capture to the parent app.** macOS attributes the helper's mic and system-audio use to the responsible process, the Every App.app that launched it, so `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` must be in **Every App.app's** Info.plist, and grants belong to Every App.app's identity (run from a terminal, they're Terminal's). The helper's embedded plist repeats the strings only for that terminal case.

How the helper reads the protocol where the table leaves room:

- `record.start` takes the meeting the app already created. Mic permission is asked there if never asked (`mic_denied` if refused). On failure nothing is left running, and the helper doesn't `/finish` the meeting (the app owns its lifecycle). Error codes: the Worker's `error` code when it gives one (e.g. `ai_provider_not_configured`), else `http_<status>`, `signed_out`, `access_login`, `capture_failed`, `start_failed`; also `busy`, `bad_params`, `shutting_down`.
- Recordings never use Apple's voice processing on the mic; `record.start` ignores an old app's `echoCancellation`. `MicCapture` still supports it (only the processed voice channel 0, 24 kHz mono, set again after a device change, no ducking) for `everyapp-helper --selftest --echo-cancellation`, a future hardware test.
- **Echo dedupe (always on):** without headphones the mic hears the other side, so `me` would repeat `them`. Each `me` segment waits 4 s for the other side's transcript, then is compared (`EchoDedupe` in HelperCore): a `them` segment within ±1.5 s whose words are mostly the same (in order, ≥ 70 % of the shorter side, folding case, accents and punctuation; character by character for CJK/Thai) makes it an echo. An echo is dropped, or trimmed to the words that weren't echo when at least 3 real words remain. A 1–2-word `me` segment ("yeah") is only an echo if it matches most of the `them` words too, so a real backchannel during a long turn is kept. Posted segments, `transcript.segment` events and the final flush (which judges everything still waiting) all go through it; `transcript.delta` stays raw, so the live view may briefly show an echo that never becomes a segment. `me` segments therefore reach `transcript.segment` about 4 s later than `them`. Fallback mode isn't deduped (the Worker stores those chunks directly).
- `record.stop` answers `{ segments, finished, unsaved? }`. `segments`: saved for the meeting during the recording. The final post waits for a periodic one still in flight, so `/finish` always comes after the last segments. If segments still can't be posted after 3 quick tries (offline, signed out), **they're handed back** in `unsaved` (`[{ seq, speaker, text, startedMs, endedMs }]`, seq order, already echo-checked) and `/finish` isn't called (notes would miss them): the app keeps them, posts them when it can (the Worker ignores a seq it already has), then calls `/finish`. `finished` is `false` then, or when `/finish` itself failed. Either way an `error` event (`save_failed`) comes first. `not_recording` when idle.
- `record.stop` while `record.start` is still asking for the mic or fetching keys cancels the start: stop answers `{ segments: 0, cancelled: true }` at once, the start answers error `cancelled`, and no audio is captured (a pending `token.needed` wait fails at once). If capture had already begun, stop waits for the start and stops it normally.
- `permissions.request` answers the same `{ mic, systemAudio }` shape as `permissions.status`. `systemAudio` is always `unknown`: there's no API to read it, and `request` starts a 1 s tap so macOS shows its prompt.
- `transcript.delta.text` is the **whole text so far** of that `itemId` (replace, don't append). Fallback mode sends no deltas, only segments.
- `transcript.segment.seq` is the segment's sort key, the same one the Worker stores and orders by: `startedMs × 4 + (them ? 2 : 0) + (replayed ? 1 : 0)` (`TranscriptSeq`). It follows when the turn started, not when it finished, so a turn replayed after an outage slots in among the live ones. Unique per meeting; not consecutive.
- `state` is sent on start, stop, mode changes, health changes and transcription changes. `mic`/`system`: `error` when capture failed or couldn't restart, `silent` after 5 s of digital silence (a denied tap, a muted device, or simply nothing playing), else `ok`. `transcription`: `reconnecting` while either speaker's transcription is down (a Realtime session reconnecting after a drop, or fallback uploads failing), then `catching_up` while the audio kept during the outage is transcribed, then `live`.
- `levels` at 10 Hz while recording: peak RMS per 100 ms on a −60…0 dBFS scale.
- `token.needed`: on a 401 from the Worker. The request waits up to 60 s for `token.update`, then is retried once; segments that still fail are kept and retried on the next 10 s tick (asking again).
- `error.fatal` is `false` for everything today (`transcription`, `capture`, `save_failed`, `fallback_backlog`); the recording goes on.
- Fallback uploads go one at a time, each attempt capped at 60 s (3 attempts). At most 8 MB (about 3 minutes) of chunks wait behind a slow upload, none older than 3 minutes; past that the oldest waiting chunks are dropped and an `error` event `fallback_backlog` says how much audio was lost. Stop drains at most that bounded queue.
- `device.changed` fires whenever the default input or output changes, recording or not, with the new device's name.
- `call.started`/`call.ended`: with `detect.set {enabled:true}` the helper polls Core Audio's process objects once a second (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`, bundle id). An app must hold the mic 3 s to start and release it 3 s to end. Known apps (helpers map to their app): Zoom (`us.zoom.xos`), Microsoft Teams, Slack, FaceTime (incl. `avconferenced`), Webex, Discord, and the browsers Chrome, Arc, Safari (incl. `com.apple.WebKit.GPU`), Edge, Firefox, Brave: for a browser the app decides whether it's a Meet call. Every App's own processes (`com.everyapp.desktop*`, and the helper's pid) are ignored. Turning detection off doesn't send `call.ended`.
