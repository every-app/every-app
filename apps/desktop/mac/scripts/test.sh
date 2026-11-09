#!/usr/bin/env bash
# `swift test` for the hardware-free parts. With only the Command Line Tools installed (no Xcode),
# Swift Testing lives outside the default search paths, so point the compiler and linker at it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ARGS=()
DEV="$(xcode-select -p)"
if [[ "${DEV}" == *CommandLineTools* ]]; then
  F="${DEV}/Library/Developer/Frameworks"
  L="${DEV}/Library/Developer/usr/lib"
  ARGS=(-Xswiftc -F -Xswiftc "${F}" -Xlinker -F -Xlinker "${F}" -Xlinker -rpath -Xlinker "${F}" -Xlinker -rpath -Xlinker "${L}")
fi
swift test ${ARGS[@]+"${ARGS[@]}"} "$@"
