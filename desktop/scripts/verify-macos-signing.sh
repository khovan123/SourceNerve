#!/usr/bin/env bash
set -euo pipefail

arch="${1:-}"
case "$arch" in
  arm64|x64) ;;
  *) echo "usage: $0 <arm64|x64>" >&2; exit 2 ;;
esac

version="$(node -p "require('./package.json').version")"
app="out/SourceNerve-darwin-$arch/SourceNerve.app"
dmg="out/make/dmg/$arch/SourceNerve-$version-$arch.dmg"
zip="$(find out/make -type f -name '*.zip' -print -quit)"

[ -d "$app" ] || { echo "missing macOS app: $app" >&2; exit 1; }
[ -f "$dmg" ] || { echo "missing macOS DMG: $dmg" >&2; exit 1; }
[ -n "$zip" ] && [ -f "$zip" ] || { echo "missing macOS update ZIP" >&2; exit 1; }

verify_app() {
  local candidate="$1"
  local label="$2"
  codesign --verify --deep --strict --verbose=2 "$candidate"
  spctl --assess --type execute --verbose=2 "$candidate"
  xcrun stapler validate "$candidate"
  local details
  details="$(codesign -dv --verbose=4 "$candidate" 2>&1 || true)"
  if ! grep -q '^Authority=.*Developer ID Application' <<<"$details"; then
    echo "$label is not signed with Developer ID Application" >&2
    exit 1
  fi
  if ! grep -q 'flags=.*runtime' <<<"$details"; then
    echo "$label signature is missing the hardened-runtime flag" >&2
    exit 1
  fi
}

verify_app "$app" "macOS app"

zip_extract="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sourcenerve-macos-zip-verify.XXXXXX")"
trap 'rm -rf "$zip_extract"' EXIT
ditto -x -k "$zip" "$zip_extract"
zipped_app="$zip_extract/SourceNerve.app"
[ -d "$zipped_app" ] || { echo "macOS update ZIP does not contain SourceNerve.app at archive root" >&2; exit 1; }
verify_app "$zipped_app" "macOS update ZIP app"

codesign --verify --verbose=2 "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
xcrun stapler validate "$dmg"
dmg_details="$(codesign -dv --verbose=4 "$dmg" 2>&1 || true)"
if ! grep -q '^Authority=.*Developer ID Application' <<<"$dmg_details"; then
  echo "macOS DMG is not signed with Developer ID Application" >&2
  exit 1
fi

echo "verified Developer ID signatures, hardened runtime, Gatekeeper assessment, and notarization staples for macOS $arch app, updater ZIP, and DMG"
