#!/usr/bin/env bash
# Cut an Every App for Mac release: the universal helper, the signed + notarized app (DMG + zip), the
# update-feed files, all verified, in apps/desktop/releases/<version>/. It never uploads anything: it
# prints the upload commands for you to run. See docs/release.md.
#
#   scripts/release-mac.sh                     dry run (the default): build, sign, notarize,
#                                              verify; no git changes, warnings instead of errors
#                                              for a dirty tree or a missing tag
#   scripts/release-mac.sh --release           the real thing: clean tree + tag everyapp-desktop-v<version>
#                                              at HEAD required (or --bump to make them)
#   scripts/release-mac.sh --release --bump patch|minor|major|X.Y.Z
#                                              sets desktop/package.json's version, commits that
#                                              file, tags everyapp-desktop-v<version>, then builds
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

MODE="dry-run"
UNSIGNED=0
BUMP=""
usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --release) MODE="release" ;;
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
OUT="${DESKTOP}/releases/${VERSION}"

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
if [[ -z "${BUMP}" ]]; then
  if [[ "$(git -C "${ROOT}" rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2> /dev/null)" != "$(git -C "${ROOT}" rev-parse HEAD)" ]]; then
    soft "No tag ${TAG} at HEAD. Tag it (git tag -a ${TAG} -m \"${PRODUCT} ${VERSION}\") or pass --bump patch|minor|major|X.Y.Z."
  fi
elif git -C "${ROOT}" rev-parse -q --verify "refs/tags/${TAG}" > /dev/null; then
  problem "Tag ${TAG} already exists; pick another --bump."
fi

# An unsigned build can't install a signed update, so it never points at the real feed.
FEED="${EVERYAPP_DESKTOP_UPDATE_URL:-${DEFAULT_FEED}}"
[[ "${UNSIGNED}" == 1 ]] && FEED="${PLACEHOLDER_FEED}"
CHANNEL="${FEED%/}"
CHANNEL="${CHANNEL##*/}"
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

# ── Version bump (release only) ──────────────────────────────────────────────
VERSION_ARGS=()
if [[ -n "${BUMP}" ]]; then
  if [[ "${MODE}" == "release" ]]; then
    step "Bumping ${DESKTOP_REL}/package.json ${CURRENT} → ${VERSION}, tagging ${TAG}"
    node -e '
      const fs = require("fs"); const [file, v] = process.argv.slice(1);
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`));' "${DESKTOP}/package.json" "${VERSION}"
    git -C "${ROOT}" commit -q -m "${PRODUCT} desktop ${VERSION}" -- "${DESKTOP_REL}/package.json"
    git -C "${ROOT}" tag -a "${TAG}" -m "${PRODUCT} desktop ${VERSION}"
  else
    note "dry run: would bump ${CURRENT} → ${VERSION} and tag ${TAG}; building as ${VERSION} without touching git"
    VERSION_ARGS=(-c.extraMetadata.version="${VERSION}")
  fi
fi

# ── Helper ───────────────────────────────────────────────────────────────────
step "Building the universal ${HELPER_NAME}"
HELPER="$(EVERYAPP_DESKTOP_HELPER_ARCHS="arm64 x86_64" EVERYAPP_DESKTOP_SIGN_ID="${IDENTITY:--}" "${DESKTOP}/mac/scripts/build-helper.sh" | tail -1)"
[[ "$(lipo -archs "${HELPER}")" == *arm64* && "$(lipo -archs "${HELPER}")" == *x86_64* ]] || die "The helper isn't universal: ${HELPER}"
note "${HELPER} ($(lipo -archs "${HELPER}"))"

# ── App ──────────────────────────────────────────────────────────────────────
step "Building the app (${DESKTOP_REL}: pnpm dist)"
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
APP="$(find "${BUILT}" -maxdepth 2 -name "${PRODUCT}.app" -type d | head -1)"
DMG="$(find "${BUILT}" -maxdepth 1 -name "*${VERSION}*.dmg" | head -1)"
ZIP="$(find "${BUILT}" -maxdepth 1 -name "*${VERSION}*-mac.zip" | head -1)"
YML="${BUILT}/latest-mac.yml"
for f in "${APP}" "${DMG}" "${ZIP}" "${YML}"; do [[ -n "${f}" && -e "${f}" ]] || die "electron-builder didn't produce everything (app, dmg, zip, latest-mac.yml) in ${BUILT}."; done

# ── Notarize + staple the DMG (electron-builder notarizes the app inside) ─────
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
  step "Notarizing and stapling the DMG"
  if xcrun stapler validate -q "${DMG}" 2> /dev/null; then
    note "already stapled"
  else
    codesign -dv "${DMG}" 2> /dev/null || codesign --sign "${IDENTITY}" --timestamp "${DMG}"
    xcrun notarytool submit "${DMG}" "${NOTARY_ARGS[@]}" --wait
    xcrun stapler staple "${DMG}"
    yml_refresh "${DMG}"
  fi
fi

# ── Verify ───────────────────────────────────────────────────────────────────
step "Verifying"
codesign --verify --deep --strict "${APP}" || die "codesign --verify --deep --strict failed for ${APP}."
note "codesign --verify --deep --strict: ok"
HELPER_IN_APP="${APP}/Contents/MacOS/${HELPER_NAME}"
[[ -x "${HELPER_IN_APP}" ]] || die "The app has no Contents/MacOS/${HELPER_NAME}."
# Not `codesign | grep -q`: grep -q exits at the first match, codesign gets SIGPIPE, and pipefail fails the check.
grep -q "^Identifier=${HELPER_ID}$" <<< "$(codesign -dv "${HELPER_IN_APP}" 2>&1)" || die "The bundled helper lost its identifier ${HELPER_ID}."
note "helper in the app: $(lipo -archs "${HELPER_IN_APP}"), identifier ${HELPER_ID}"
for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :${key}" "${APP}/Contents/Info.plist" > /dev/null || die "Info.plist lacks ${key}."
done
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Contents/Info.plist")" == "${VERSION}" ]] || die "The app's version isn't ${VERSION}."
note "Info.plist: version ${VERSION}, mic + audio-capture usage strings"
UNZIPPED="$(mktemp -d)"
trap 'rm -rf "${UNZIPPED}"' EXIT
ditto -x -k "${ZIP}" "${UNZIPPED}"
codesign --verify --deep --strict "${UNZIPPED}/${PRODUCT}.app" || die "The app inside the update zip doesn't verify."
note "update zip: the app inside verifies"
if [[ "${UNSIGNED}" == 0 ]]; then
  codesign -dv --verbose=2 "${APP}" 2>&1 | grep -E "^(Authority=Developer ID Application|TeamIdentifier)" | sed 's/^/  /'
  spctl -a -vvv -t exec "${APP}" 2>&1 | sed 's/^/  /'
  xcrun stapler validate "${APP}" | sed 's/^/  /'
  xcrun stapler validate "${UNZIPPED}/${PRODUCT}.app" | sed 's/^/  /'
  spctl -a -vvv -t install "${DMG}" 2>&1 | sed 's/^/  /'
  xcrun stapler validate "${DMG}" | sed 's/^/  /'
else
  note "unsigned: skipped spctl (Gatekeeper) and stapler checks; a signed run does:"
  note "  spctl -a -vvv -t exec ${PRODUCT}.app · xcrun stapler validate ${PRODUCT}.app · spctl -a -vvv -t install <dmg> · xcrun stapler validate <dmg>"
fi
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const [yml, zip, version] = process.argv.slice(1); const text = fs.readFileSync(yml, "utf8");
  if (!text.includes(`version: ${version}`)) throw new Error(`latest-mac.yml is not for ${version}`);
  const sha = crypto.createHash("sha512").update(fs.readFileSync(zip)).digest("base64");
  if (!text.includes(`url: ${path.basename(zip)}`) || !text.includes(sha)) throw new Error("latest-mac.yml does not match the zip");' "${YML}" "${ZIP}" "${VERSION}"
note "latest-mac.yml: version ${VERSION}, zip hash matches"

# ── Collect ──────────────────────────────────────────────────────────────────
step "Writing ${OUT#"${ROOT}/"}"
rm -rf "${OUT}"
mkdir -p "${OUT}"
cp "${DMG}" "${ZIP}" "${YML}" "${OUT}/"
for f in "${ZIP}.blockmap" "${DMG}.blockmap"; do [[ -f "${f}" ]] && cp "${f}" "${OUT}/"; done
(cd "${OUT}" && shasum -a 256 * > SHA256SUMS)
ls -lh "${OUT}" | sed 's/^/  /'

# ── What to upload (never run here) ──────────────────────────────────────────
FILES=()
for f in "${OUT}"/*; do
  name="$(basename "${f}")"
  [[ "${name}" == latest-mac.yml || "${name}" == SHA256SUMS ]] || FILES+=("${name}")
done
step "Nothing was uploaded. To publish on ${FEED}, run these (latest-mac.yml goes last):"
cat << EOF

  cd "${DESKTOP}"
  # Release files are cached as immutable: never re-upload a different file under a published name.
$(for f in "${FILES[@]}"; do echo "  pnpm exec wrangler r2 object put \"${UPDATE_BUCKET}/${CHANNEL}/${f}\" --file releases/${VERSION}/${f} --remote"; done)
  pnpm exec wrangler r2 object put "${UPDATE_BUCKET}/${CHANNEL}/latest-mac.yml" --file releases/${VERSION}/latest-mac.yml --remote

EOF
if [[ "${MODE}" == "release" ]]; then
  note "Then push the tag: git push origin ${TAG}"
else
  note "This was a dry run$([[ ${UNSIGNED} == 1 ]] && echo " with ad hoc signatures: don't ship these files")."
fi
