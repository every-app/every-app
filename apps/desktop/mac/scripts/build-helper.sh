#!/usr/bin/env bash
# Builds everyapp-helper for release as a universal binary (arm64 + x86_64), embeds its Info.plist,
# and signs it with the hardened runtime and the audio-input entitlement. Output:
#
#   mac/.build/helper/everyapp-helper      <- the desktop app's packaging copies this to
#                                         Every App.app/Contents/MacOS/everyapp-helper
#
# Signing identity: EVERYAPP_DESKTOP_SIGN_ID if set (a Developer ID for releases), else the self-signed
# "Scrawl Dev" code-signing cert if this Mac's keychain has it (a stable identity, so TCC grants
# survive rebuilds), else ad hoc. Identifier com.everyapp.desktop.helper. No notarization here: the
# app bundle is notarized as a whole.
#
# EVERYAPP_DESKTOP_HELPER_ARCHS="arm64" builds one arch (faster while developing).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
OUT_DIR="${ROOT}/.build/helper"
OUT="${OUT_DIR}/everyapp-helper"
ARCHS=(${EVERYAPP_DESKTOP_HELPER_ARCHS:-arm64 x86_64})
PLIST="${ROOT}/Resources/helper-Info.plist"
ENTITLEMENTS="${ROOT}/Resources/helper.entitlements"
IDENTIFIER="com.everyapp.desktop.helper"

mkdir -p "${OUT_DIR}"
SLICES=()
for arch in "${ARCHS[@]}"; do
  echo "Building everyapp-helper (${arch})…" >&2
  BIN="$(swift build -c release --product everyapp-helper --triple "${arch}-apple-macosx15.0" --scratch-path "${ROOT}/.build/helper-${arch}" --show-bin-path)/everyapp-helper"
  # SwiftPM doesn't track the Info.plist the linker embeds: with the sources unchanged it keeps
  # the cached binary and its old plist. Removing it forces a relink (the objects stay cached).
  rm -f "${BIN}"
  swift build -c release --product everyapp-helper \
    --triple "${arch}-apple-macosx15.0" \
    --scratch-path "${ROOT}/.build/helper-${arch}" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "${PLIST}" >&2
  # Without the ATS exception the helper can't reach a local server (http://talk.localhost).
  if ! launchctl plist __TEXT,__info_plist "${BIN}" 2>/dev/null | grep -q NSAppTransportSecurity; then
    echo "error: ${BIN} doesn't embed ${PLIST} (no NSAppTransportSecurity)" >&2
    exit 1
  fi
  SLICES+=("${BIN}")
done
rm -f "${OUT}"
lipo -create "${SLICES[@]}" -output "${OUT}"

SIGN_ID="-"
if [[ -n "${EVERYAPP_DESKTOP_SIGN_ID:-}" ]]; then
  SIGN_ID="${EVERYAPP_DESKTOP_SIGN_ID}"
elif security find-identity -v -p codesigning 2>/dev/null | grep -q '"Scrawl Dev"'; then
  SIGN_ID="Scrawl Dev"
else
  echo "warning: no EVERYAPP_DESKTOP_SIGN_ID and no \"Scrawl Dev\" cert; signing ad hoc (TCC asks again after each rebuild)" >&2
fi
TIMESTAMP=(--timestamp=none)
# A Developer ID signature that will be notarized needs a secure timestamp.
[[ "${SIGN_ID}" == Developer\ ID* ]] && TIMESTAMP=(--timestamp)
codesign --force --options runtime "${TIMESTAMP[@]}" \
  --identifier "${IDENTIFIER}" --entitlements "${ENTITLEMENTS}" \
  --sign "${SIGN_ID}" "${OUT}"
codesign --verify --strict "${OUT}"

[[ "${SIGN_ID}" == "-" ]] && LABEL="ad hoc" || LABEL="${SIGN_ID}"
echo "Signed with: ${LABEL}" >&2
lipo -archs "${OUT}" >&2
echo "${OUT}"
