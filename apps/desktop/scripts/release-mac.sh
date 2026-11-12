#!/usr/bin/env bash
# Cut an Every App for Mac release: the universal helper, the signed + notarized app for Apple Silicon
# and for Intel (a DMG + an update zip each), the update-feed files, all verified, in
# apps/desktop/releases/<version>/. A release then asks whether to publish it. See docs/release.md.
#
#   scripts/release-mac.sh                     dry run (the default): build, sign, notarize, verify into
#                                              releases/<version>-dry-run/; no git changes, warnings
#                                              instead of errors for a dirty tree or a missing tag
#   scripts/release-mac.sh --release --bump patch|minor|major|X.Y.Z
#                                              the real thing, from a clean main: builds and verifies, then
#                                              commits desktop/package.json's new version, tags
#                                              everyapp-desktop-v<version> and asks "Publish now?"
#   scripts/release-mac.sh --release           the same for a tag everyapp-desktop-v<version> already at HEAD
#   scripts/release-mac.sh --publish X.Y.Z     publish releases/X.Y.Z/: upload it to the feed (latest-mac.yml
#                                              last), check the feed serves it, push main and the tag
#   scripts/release-mac.sh --dry-run --unsigned   no credentials: ad hoc signing, no notarization,
#                                              proves the pipeline end to end
#
# Environment:
#   EVERYAPP_DESKTOP_SIGN_ID       the "Developer ID Application: …" identity (default: the only one in the
#                      keychain)
#   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER     notarization, or
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#   EVERYAPP_DESKTOP_UPDATE_URL    the update feed baked into the app (default https://updates.everyapp.com/mac,
#                      served by updates/; a build signed by another team needs its own feed)
set -euo pipefail
shopt -s nullglob

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git -C "${DESKTOP}" rev-parse --show-toplevel)"
DESKTOP_REL="${DESKTOP#"${ROOT}/"}"
# Names come from identity.json: the tag prefix, the app bundle's name, the helper and its id.
ident() { node -p "require('${DESKTOP}/identity.json').$1"; }
TAG_PREFIX="$(ident releaseTagPrefix)"
PRODUCT="$(ident release.productName)"
HELPER_NAME="$(ident helper.binary)"
HELPER_ID="$(ident helper.bundleId)"
DEFAULT_FEED="https://updates.everyapp.com/mac"
PLACEHOLDER_FEED="https://updates.invalid/everyapp/mac/"
UPDATE_BUCKET="everyapp-desktop-updates"  # updates/wrangler.jsonc
ARCHS=(arm64 x64)  # electron-builder.config.cjs builds one app per architecture

MODE="dry-run"
UNSIGNED=0
BUMP=""
PUBLISH_VERSION=""
usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --release) MODE="release" ;;
    --publish) MODE="publish"; PUBLISH_VERSION="${2:?--publish needs the version, e.g. 0.1.3}"; shift ;;
    --unsigned) UNSIGNED=1 ;;
    --bump) BUMP="${2:?--bump needs patch, minor, major or X.Y.Z}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33mwarning:\033[0m %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${MODE}" == "release" && "${UNSIGNED}" == 1 ]]; then die "--release can't be --unsigned: a release is signed and notarized."; fi

FEED="${EVERYAPP_DESKTOP_UPDATE_URL:-${DEFAULT_FEED}}"
# An unsigned build can't install a signed update, so it never points at the real feed.
[[ "${UNSIGNED}" == 1 ]] && FEED="${PLACEHOLDER_FEED}"
FEED="${FEED%/}"
CHANNEL="${FEED##*/}"

# ── Publish: upload a built release, check the feed serves it, push main + the tag ──
publish() {
  local version="$1" dir="${DESKTOP}/releases/$1" tag="${TAG_PREFIX}$1"
  [[ -f "${dir}/latest-mac.yml" ]] || die "No release in ${dir#"${ROOT}/"} (build it with --release first)."
  git -C "${ROOT}" rev-parse -q --verify "refs/tags/${tag}" > /dev/null || die "No tag ${tag}: publish only what a --release run built."
  grep -qx "version: ${version}" "${dir}/latest-mac.yml" || die "${dir#"${ROOT}/"}/latest-mac.yml isn't for ${version}."

  # Git first: if main moved on, stop before anything goes live.
  step "Pushing ${tag} (and main, if it doesn't have it yet)"
  git -C "${ROOT}" fetch -q origin main
  local refs=("refs/tags/${tag}")
  git -C "${ROOT}" merge-base --is-ancestor "${tag}^{commit}" origin/main || refs+=("${tag}^{commit}:refs/heads/main")
  git -C "${ROOT}" push --atomic origin "${refs[@]}" ||
    die "Couldn't push. If main moved on, bring ${tag} onto main, then run: scripts/release-mac.sh --publish ${version}"

  step "Uploading to ${FEED} (latest-mac.yml last)"
  local files=() f name
  for f in "${dir}"/*; do
    name="$(basename "${f}")"
    [[ "${name}" == latest-mac.yml || "${name}" == SHA256SUMS ]] || files+=("${name}")
  done
  # Release files are cached as immutable: a published name never gets a different file.
  for name in "${files[@]}" latest-mac.yml; do
    note "${name}"
    (cd "${DESKTOP}" && pnpm exec wrangler r2 object put "${UPDATE_BUCKET}/${CHANNEL}/${name}" --file "${dir}/${name}" --remote > /dev/null)
  done

  step "Checking the feed"
  curl -fsS "${FEED}/latest-mac.yml" | grep -qx "version: ${version}" || die "${FEED}/latest-mac.yml doesn't say version ${version} yet."
  note "latest-mac.yml: version ${version}"
  for name in "${files[@]}"; do
    curl -fsSI -o /dev/null "${FEED}/${name}" || die "${FEED}/${name} isn't served."
  done
  note "all ${#files[@]} release files: 200"
  local arch
  for arch in "${ARCHS[@]}"; do
    local target
    target="$(curl -sS -o /dev/null -w '%{redirect_url}' "${FEED}/download/${arch}" || true)"
    if [[ "${target}" == *"-${version}-${arch}.dmg" ]]; then note "download link (${arch}): ${FEED}/download/${arch}"
    else warn "${FEED}/download/${arch} doesn't point at the ${version} DMG yet (is the updates Worker deployed?)"; fi
  done
  step "Published ${PRODUCT} ${version}. Installed copies update within 6 hours, or at their next launch."
}

if [[ "${MODE}" == "publish" ]]; then
  publish "${PUBLISH_VERSION}"
  exit 0
fi

# ── Version ─────────────────────────────────────────────────────────────────
CURRENT="$(node -p "require('${DESKTOP}/package.json').version")"
next_version() {
  node -e '
    const [cur, bump] = process.argv.slice(1);
    if (/^\d+\.\d+\.\d+$/.test(bump)) { console.log(bump); process.exit(0); }
    const [a, b, c] = cur.split(".").map(Number);
    const out = { major: `${a + 1}.0.0`, minor: `${a}.${b + 1}.0`, patch: `${a}.${b}.${c + 1}` }[bump];
    if (!out) { console.error(`--bump: expected patch, minor, major or X.Y.Z, got ${bump}`); process.exit(1); }
    console.log(out);' "${CURRENT}" "$1"
}
VERSION="${CURRENT}"
[[ -n "${BUMP}" ]] && VERSION="$(next_version "${BUMP}")"
TAG="${TAG_PREFIX}${VERSION}"
# A dry run has its own folder, so it never blocks the real release of the same version.
OUT="${DESKTOP}/releases/${VERSION}"
[[ "${MODE}" == "dry-run" ]] && OUT="${DESKTOP}/releases/${VERSION}-dry-run"

step "${PRODUCT} ${VERSION} (${MODE}$([[ ${UNSIGNED} == 1 ]] && echo ", unsigned"))"

# ── Prerequisites: collect every problem, then stop once ─────────────────────
step "Checking prerequisites"
PROBLEMS=()
problem() { PROBLEMS+=("$1"); }
soft() { if [[ "${MODE}" == "release" ]]; then problem "$1"; else warn "$1 (ok for a dry run)"; fi; }

[[ "$(uname)" == "Darwin" ]] || problem "This needs macOS."
for tool in node pnpm swift xcrun codesign lipo hdiutil git; do
  command -v "${tool}" > /dev/null || problem "Missing tool: ${tool}."
done
[[ -d "${DESKTOP}/node_modules" ]] || problem "${DESKTOP_REL}/ has no node_modules: run \`pnpm install\` at the repo root."

IDENTITY=""
NOTARY_ARGS=()
if [[ "${UNSIGNED}" == 0 ]]; then
  IDS="$(security find-identity -v -p codesigning 2> /dev/null | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | sort -u)"
  if [[ -n "${EVERYAPP_DESKTOP_SIGN_ID:-}" ]]; then
    if grep -qxF "${EVERYAPP_DESKTOP_SIGN_ID}" <<< "${IDS}"; then IDENTITY="${EVERYAPP_DESKTOP_SIGN_ID}"; else
      problem "EVERYAPP_DESKTOP_SIGN_ID=\"${EVERYAPP_DESKTOP_SIGN_ID}\" isn't a Developer ID Application identity in the keychain. Found: ${IDS:-none}."
    fi
  elif [[ -z "${IDS}" ]]; then
    problem "No \"Developer ID Application\" identity in the keychain. Install the certificate (docs/release.md, \"Once\"), or use --dry-run --unsigned."
  elif [[ "$(wc -l <<< "${IDS}" | tr -d ' ')" != 1 ]]; then
    problem "Several Developer ID identities; pick one with EVERYAPP_DESKTOP_SIGN_ID=\"…\": $(tr '\n' ';' <<< "${IDS}")"
  else
    IDENTITY="${IDS}"
  fi
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    [[ -f "${APPLE_API_KEY}" ]] || problem "APPLE_API_KEY must be the path to the .p8 key file; ${APPLE_API_KEY} doesn't exist."
    NOTARY_ARGS=(--key "${APPLE_API_KEY}" --key-id "${APPLE_API_KEY_ID}" --issuer "${APPLE_API_ISSUER}")
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    NOTARY_ARGS=(--apple-id "${APPLE_ID}" --password "${APPLE_APP_SPECIFIC_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
  else
    problem "No notarization credentials: set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (recommended), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID."
  fi
fi

if [[ -n "$(git -C "${ROOT}" status --porcelain)" ]]; then soft "The git tree isn't clean (commit or stash first)."; fi
# Publishing pushes the release commit to main, so a release is cut from main.
[[ "$(git -C "${ROOT}" symbolic-ref -q --short HEAD)" == main ]] || soft "Not on main (git switch main && git pull)."
if [[ -z "${BUMP}" ]]; then
  if [[ "$(git -C "${ROOT}" rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2> /dev/null)" != "$(git -C "${ROOT}" rev-parse HEAD)" ]]; then
    soft "No tag ${TAG} at HEAD. Pass --bump patch|minor|major|X.Y.Z (or tag HEAD ${TAG} yourself)."
  fi
elif git -C "${ROOT}" rev-parse -q --verify "refs/tags/${TAG}" > /dev/null; then
  problem "Tag ${TAG} already exists; pick another --bump."
fi
if [[ "${MODE}" == "release" && -e "${OUT}" ]]; then problem "${OUT} already exists (a release is never overwritten)."; fi

if [[ ${#PROBLEMS[@]} -gt 0 ]]; then
  printf '\n\033[31mCan'"'"'t continue:\033[0m\n' >&2
  for p in "${PROBLEMS[@]}"; do printf '  • %s\n' "${p}" >&2; done
  exit 1
fi
if [[ "${UNSIGNED}" == 0 ]]; then
  note "identity: ${IDENTITY}"
  note "notarization: ${NOTARY_ARGS[0]#--} credentials"
else
  note "unsigned: ad hoc signatures, no notarization (not shippable)"
fi
note "update feed baked into the app: ${FEED}"

# The new version is built in without touching package.json; a release commits and tags it only
# once the build has verified, so a failed run leaves git as it was and the version free.
VERSION_ARGS=()
if [[ -n "${BUMP}" ]]; then
  note "building ${CURRENT} → ${VERSION}$([[ ${MODE} == dry-run ]] && echo " (dry run: git stays as it is)")"
  VERSION_ARGS=(-c.extraMetadata.version="${VERSION}")
fi

# ── Helper ───────────────────────────────────────────────────────────────────
step "Building the universal ${HELPER_NAME}"
HELPER="$(EVERYAPP_DESKTOP_HELPER_ARCHS="arm64 x86_64" EVERYAPP_DESKTOP_SIGN_ID="${IDENTITY:--}" "${DESKTOP}/mac/scripts/build-helper.sh" | tail -1)"
[[ "$(lipo -archs "${HELPER}")" == *arm64* && "$(lipo -archs "${HELPER}")" == *x86_64* ]] || die "The helper isn't universal: ${HELPER}"
note "${HELPER} ($(lipo -archs "${HELPER}"))"

# ── Apps ─────────────────────────────────────────────────────────────────────
step "Building the apps for ${ARCHS[*]} (${DESKTOP_REL}: pnpm dist)"
rm -rf "${DESKTOP}/dist/release"
BUILD_ENV=(EVERYAPP_DESKTOP_HELPER_BINARY="${HELPER}" EVERYAPP_DESKTOP_UPDATE_URL="${FEED}" CSC_IDENTITY_AUTO_DISCOVERY=false)
if [[ "${UNSIGNED}" == 0 ]]; then
  # electron-builder wants the certificate name without its type prefix.
  BUILD_ENV+=(CSC_NAME="${IDENTITY#Developer ID Application: }")
  (cd "${DESKTOP}" && env "${BUILD_ENV[@]}" pnpm dist ${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"})
else
  # Nothing that could sign or notarize leaks in from the shell.
  (cd "${DESKTOP}" && env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
    -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID "${BUILD_ENV[@]}" pnpm dist ${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"})
fi

BUILT="${DESKTOP}/dist/release"
YML="${BUILT}/latest-mac.yml"
[[ -f "${YML}" ]] || die "electron-builder didn't write latest-mac.yml in ${BUILT}."
# One app, DMG and zip per architecture, in ARCHS order: dist/release/mac-arm64/ holds the arm64 app,
# mac/ the x64 one.
APPS=() DMGS=() ZIPS=()
for arch in "${ARCHS[@]}"; do
  dir="mac-${arch}"
  [[ "${arch}" == x64 ]] && dir="mac"
  APPS+=("${BUILT}/${dir}/${PRODUCT}.app")
  DMGS+=("${BUILT}/EveryApp-${VERSION}-${arch}.dmg")
  ZIPS+=("${BUILT}/EveryApp-${VERSION}-${arch}-mac.zip")
done
for f in "${APPS[@]}" "${DMGS[@]}" "${ZIPS[@]}"; do
  [[ -e "${f}" ]] || die "electron-builder didn't produce ${f#"${BUILT}/"}."
done

# ── Notarize + staple the DMGs (electron-builder notarizes the apps inside) ───
yml_refresh() {
  # The DMG changed after electron-builder hashed it: update its sha512 and size in latest-mac.yml.
  node -e '
    const fs = require("fs"), crypto = require("crypto"), path = require("path");
    const [yml, file] = process.argv.slice(1); const name = path.basename(file);
    const data = fs.readFileSync(file);
    const sha = crypto.createHash("sha512").update(data).digest("base64");
    const lines = fs.readFileSync(yml, "utf8").split("\n"); let inEntry = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*- url:/.test(lines[i])) inEntry = lines[i].trim() === `- url: ${name}`;
      else if (inEntry && /^\s+sha512:/.test(lines[i])) lines[i] = lines[i].replace(/sha512:.*/, `sha512: ${sha}`);
      else if (inEntry && /^\s+size:/.test(lines[i])) lines[i] = lines[i].replace(/size:.*/, `size: ${data.length}`);
    }
    fs.writeFileSync(yml, lines.join("\n"));' "${YML}" "$1"
  rm -f "$1.blockmap"  # stale now; macOS updates use the zip's blockmap
}
if [[ "${UNSIGNED}" == 0 ]]; then
  for dmg in "${DMGS[@]}"; do
    step "Notarizing and stapling $(basename "${dmg}")"
    if xcrun stapler validate -q "${dmg}" 2> /dev/null; then
      note "already stapled"
    else
      codesign -dv "${dmg}" 2> /dev/null || codesign --sign "${IDENTITY}" --timestamp "${dmg}"
      xcrun notarytool submit "${dmg}" "${NOTARY_ARGS[@]}" --wait
      xcrun stapler staple "${dmg}"
      yml_refresh "${dmg}"
    fi
  done
fi

# ── Verify ───────────────────────────────────────────────────────────────────
UNZIPPED="$(mktemp -d)"
trap 'rm -rf "${UNZIPPED}"' EXIT
for i in "${!ARCHS[@]}"; do
  arch="${ARCHS[${i}]}" app="${APPS[${i}]}" dmg="${DMGS[${i}]}" zip="${ZIPS[${i}]}"
  step "Verifying ${arch}"
  want="${arch/x64/x86_64}"
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${app}/Contents/Info.plist")"
  [[ "$(lipo -archs "${app}/Contents/MacOS/${exe}")" == "${want}" ]] || die "${app#"${BUILT}/"} isn't a ${want}-only build."
  codesign --verify --deep --strict "${app}" || die "codesign --verify --deep --strict failed for ${app}."
  note "${want} app; codesign --verify --deep --strict: ok"
  HELPER_IN_APP="${app}/Contents/MacOS/${HELPER_NAME}"
  [[ -x "${HELPER_IN_APP}" ]] || die "The app has no Contents/MacOS/${HELPER_NAME}."
  # Not `codesign | grep -q`: grep -q exits at the first match, codesign gets SIGPIPE, and pipefail fails the check.
  grep -q "^Identifier=${HELPER_ID}$" <<< "$(codesign -dv "${HELPER_IN_APP}" 2>&1)" || die "The bundled helper lost its identifier ${HELPER_ID}."
  note "helper in the app: $(lipo -archs "${HELPER_IN_APP}"), identifier ${HELPER_ID}"
  for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription; do
    /usr/libexec/PlistBuddy -c "Print :${key}" "${app}/Contents/Info.plist" > /dev/null || die "Info.plist lacks ${key}."
  done
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app}/Contents/Info.plist")" == "${VERSION}" ]] || die "The app's version isn't ${VERSION}."
  note "Info.plist: version ${VERSION}, mic + audio-capture usage strings"
  ditto -x -k "${zip}" "${UNZIPPED}/${arch}"
  codesign --verify --deep --strict "${UNZIPPED}/${arch}/${PRODUCT}.app" || die "The app inside the ${arch} update zip doesn't verify."
  note "update zip: the app inside verifies"
  if [[ "${UNSIGNED}" == 0 ]]; then
    codesign -dv --verbose=2 "${app}" 2>&1 | grep -E "^(Authority=Developer ID Application|TeamIdentifier)" | sed 's/^/  /'
    spctl -a -vvv -t exec "${app}" 2>&1 | sed 's/^/  /'
    xcrun stapler validate "${app}" | sed 's/^/  /'
    xcrun stapler validate "${UNZIPPED}/${arch}/${PRODUCT}.app" | sed 's/^/  /'
    spctl -a -vvv -t install "${dmg}" 2>&1 | sed 's/^/  /'
    xcrun stapler validate "${dmg}" | sed 's/^/  /'
  fi
done
[[ "${UNSIGNED}" == 0 ]] || note "unsigned: skipped spctl (Gatekeeper) and stapler checks"
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const [yml, version, ...zips] = process.argv.slice(1); const text = fs.readFileSync(yml, "utf8");
  if (!text.includes(`version: ${version}`)) throw new Error(`latest-mac.yml is not for ${version}`);
  for (const zip of zips) {
    const sha = crypto.createHash("sha512").update(fs.readFileSync(zip)).digest("base64");
    if (!text.includes(`url: ${path.basename(zip)}`) || !text.includes(sha)) throw new Error(`latest-mac.yml does not match ${path.basename(zip)}`);
  }' "${YML}" "${VERSION}" "${ZIPS[@]}"
note "latest-mac.yml: version ${VERSION}, both zip hashes match"

# ── Collect ──────────────────────────────────────────────────────────────────
step "Writing ${OUT#"${ROOT}/"}"
rm -rf "${OUT}"
mkdir -p "${OUT}"
cp "${DMGS[@]}" "${ZIPS[@]}" "${YML}" "${OUT}/"
for f in "${ZIPS[@]/%/.blockmap}" "${DMGS[@]/%/.blockmap}"; do [[ -f "${f}" ]] && cp "${f}" "${OUT}/"; done
(cd "${OUT}" && shasum -a 256 * > SHA256SUMS)
ls -lh "${OUT}" | sed 's/^/  /'

if [[ "${MODE}" == "dry-run" ]]; then
  note "This was a dry run$([[ ${UNSIGNED} == 1 ]] && echo " with ad hoc signatures: don't ship these files"). Nothing was committed or uploaded."
  exit 0
fi

# ── Commit + tag (the build verified), then publish ──────────────────────────
if [[ -n "${BUMP}" ]]; then
  step "Committing ${DESKTOP_REL}/package.json ${CURRENT} → ${VERSION}, tagging ${TAG}"
  node -e '
    const fs = require("fs"); const [file, v] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`));' "${DESKTOP}/package.json" "${VERSION}"
  git -C "${ROOT}" commit -q -m "${PRODUCT} desktop ${VERSION}" -- "${DESKTOP_REL}/package.json"
  git -C "${ROOT}" tag -a "${TAG}" -m "${PRODUCT} desktop ${VERSION}"
fi

ANSWER=""
if [[ -t 0 ]]; then read -r -p $'\n'"Publish ${VERSION} to ${FEED} now? [y/N] " ANSWER; fi
if [[ "${ANSWER}" =~ ^[Yy] ]]; then
  publish "${VERSION}"
else
  step "Not published. When you're ready, from ${DESKTOP_REL}:"
  printf '\n  scripts/release-mac.sh --publish %s\n\n' "${VERSION}"
fi
