# Releasing Every App for Mac

One command, from `apps/desktop` on a Mac, builds, signs, notarizes and verifies a release, then prints the upload commands. **It never uploads anything itself.**

```sh
scripts/release-mac.sh --release --bump patch     # or minor / major / 1.2.3 (also: pnpm release -- --release --bump patch)
```

Releases are tagged `everyapp-desktop-v<version>` and named `EveryApp-<version>-universal-mac.zip` / `EveryApp-<version>-universal.dmg`. The names come from `identity.json` (README.md, "Identity").

## Once: set up signing (about 20 minutes)

Keep all of this in your login Keychain and shell, **never in the repo**.

| What | How | Ends up |
| --- | --- | --- |
| **Developer ID Application certificate** | developer.apple.com → Certificates → "+" → Developer ID Application (G2 Sub-CA). Make the CSR with Keychain Access → Certificate Assistant, then double-click the downloaded `.cer`. | Login Keychain. Check it with `security find-identity -v -p codesigning`, which should show `Developer ID Application: Ben Senescu (TEAMID)`. |
| **App Store Connect API key** (for notarytool) | appstoreconnect.apple.com → Users and Access → Integrations → Team Keys → "+", role *Developer*. Download the `.p8` (you only get one chance) and note the Key ID and Issuer ID. | `~/.private_keys/AuthKey_<KEYID>.p8`, mode 0600 |
| **Env for the release shell** | Put it in `~/.everyapp-desktop-release.env` (0600, outside the repo) and `source` it before releasing. | See below |

```sh
# ~/.everyapp-desktop-release.env (chmod 600)
export APPLE_API_KEY=/Users/<you>/.private_keys/AuthKey_ABC123XYZ.p8   # full path: fish doesn't expand ~ here
export APPLE_API_KEY_ID=ABC123XYZ
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
# Only if the keychain holds more than one Developer ID:
# export EVERYAPP_DESKTOP_SIGN_ID="Developer ID Application: Ben Senescu (TEAMID)"
```

The fallback for notarization is `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com) + `APPLE_TEAM_ID`. The API key is better: it isn't tied to your Apple ID password or 2FA.

## Cut a release

1. Start from an up-to-date `main` with a clean tree, run `pnpm install` at the repository root, and `cd apps/desktop`.
2. Run `source ~/.everyapp-desktop-release.env`.
3. **Dry run first** (the default). It builds, signs, notarizes and verifies, but doesn't change git:
   ```sh
   scripts/release-mac.sh --bump patch
   ```
4. **Real run.** This bumps `apps/desktop/package.json`, commits it, tags `everyapp-desktop-v<version>`, builds and verifies:
   ```sh
   scripts/release-mac.sh --release --bump patch
   ```
   If you already tagged HEAD as `everyapp-desktop-v<version>`, leave out `--bump`.
5. The output lands in `apps/desktop/releases/<version>/` (git-ignored): the DMG, the zip, `latest-mac.yml`, blockmaps and `SHA256SUMS`.
6. The script prints the upload commands (run them from `apps/desktop`). Run them **with `latest-mac.yml` last**, then push the bump commit and the tag. Push the commit straight to `main` rather than squash-merging a pull request, or the tag points at a commit `main` doesn't have:
   ```sh
   git push origin main everyapp-desktop-v<version>
   ```

What the script checks before building:
- a Developer ID identity;
- notarization credentials;
- a clean tree;
- the tag (or `--bump`);
- that the output folder doesn't already exist.

It lists everything missing and stops. In a dry run, the tree, tag and feed checks only warn.

What it verifies after building:
- `codesign --verify --deep --strict`;
- `spctl -a -vvv -t exec` on the app and `spctl -a -vvv -t install` on the DMG;
- `xcrun stapler validate` on the app, the app inside the zip, and the DMG;
- the helper is universal and signed as `com.everyapp.desktop.helper`;
- the version and mic/audio usage strings in Info.plist;
- `latest-mac.yml` matches the zip.

electron-builder notarizes the app; the script then notarizes and staples the DMG.

**No credentials yet?** `scripts/release-mac.sh --dry-run --unsigned` runs the same pipeline with ad hoc signatures and no notarization. The files are *not* shippable.

## Check the hardware (1 minute, before handing out the alpha)

On the Mac that will run the release, with no account and no network needed:

```sh
"/Applications/Every App.app/Contents/MacOS/everyapp-helper" --selftest --seconds 15
```

While it runs, play a YouTube video through the speakers (not headphones) and talk. Expect `mic: OK`, `system audio: OK`, no clipping, no dropouts, and `PASS`. `DENIED` on system audio means nothing was playing or System Settings → Privacy & Security → System Audio Recording is off for the app that ran it (the terminal here; Every App itself when it's run from Settings). The same check is in Every App under Settings → "Check microphone & Mac audio" (live meters until Stop).

`--echo-cancellation` turns on Apple's voice processing on the mic for this check only; it should say `voice processing on`, with the video still at full volume. Recordings never use it (the Settings toggle is gone; text-level echo dedupe handles laptop speakers). It's kept only for a future hardware test.

## Update feed

electron-updater reads `latest-mac.yml` from the feed and installs from the zip. The feed URL is baked into the app at build time, so changing it later means one manual reinstall for everyone on the old one.

The feed is **`https://updates.everyapp.com/mac`**: public, the same signed builds for every workspace, no token on update checks. The app does nothing without a workspace, so anyone downloading it is harmless. `updates/` is the Worker that serves it, read-only, from the R2 bucket `everyapp-desktop-updates` (files under `mac/`):

- only `latest-mac.yml` and `EveryApp-<version>[-…].zip|dmg` (and their `.blockmap`s); anything else 404s;
- `latest-mac.yml` is `no-cache`; release files are `immutable` for a year;
- single `bytes=` Range requests, so blockmap differential downloads work.

Deploy it (once, and after changing `updates/`) from `apps/desktop`, logged in to Every App's main Cloudflare account:

```sh
pnpm exec wrangler r2 bucket create everyapp-desktop-updates    # once
pnpm deploy:updates
```

`scripts/release-mac.sh` bakes in that feed unless `EVERYAPP_DESKTOP_UPDATE_URL` says otherwise, and `--unsigned` builds get a placeholder (they can't install a signed update). **A build signed by a different Apple team needs its own feed** (another channel in `updates/index.ts`, e.g. `/mac-business`): Squirrel.Mac refuses an update signed by a different team, so the old feed's last release has to tell people to download the new app instead.

Uploads (the script prints them; run from `apps/desktop`):

```sh
pnpm exec wrangler r2 object put "everyapp-desktop-updates/mac/<file>" --file releases/<version>/<file> --remote   # each zip, dmg, blockmap
pnpm exec wrangler r2 object put "everyapp-desktop-updates/mac/latest-mac.yml" --file releases/<version>/latest-mac.yml --remote   # last
```

- **`latest-mac.yml` goes last**, so no client ever sees a feed naming a file that isn't there yet.
- **Never re-upload a different file under a published name.** Bump the version instead.

## Check that an update keeps the sign-in (alpha checklist)

The sign-in is encrypted with a key in the login Keychain. Under a Developer ID, its partition is your **Team ID**, so any build you sign can read it. Self-signed and ad hoc builds can't, which is why dev rebuilds sign you out. The item is "com.everyapp.desktop Safe Storage" whatever the display name is (README.md, "Identity"); on the first signed release, check in Keychain Access that it has that name.

1. Release **N** (for example 0.1.0), install it from the DMG on a test account, sign in, and record a short meeting.
2. Release **N+1** with the same identity and upload it.
3. Wait for the check (at launch, then every 6 h), or quit and reopen. The app downloads N+1 and installs it on quit.
4. Reopen. It should still be signed in with no Keychain prompt, show version N+1 in Settings, and still have its mic and system-audio grants.
5. If it asks you to sign in again, the two builds weren't signed by the same Team ID. Compare `codesign -dv --verbose=2 "/Applications/Every App.app" 2>&1 | grep TeamIdentifier` across versions.

## Rollback

- **Stop a bad release from spreading:** upload the previous version's `latest-mac.yml` again, leaving its files where they are. Copies that haven't updated yet stay put.
- **Copies that already updated** don't downgrade by themselves (electron-updater only moves forward). Ship a fix as N+2. If that can't wait, have people reinstall the old DMG from `apps/desktop/releases/<old>/` or the bucket.
- Keep every `apps/desktop/releases/<version>/` folder (or the bucket's copies). The tags record what was built.
