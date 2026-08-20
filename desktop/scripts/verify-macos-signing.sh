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

[ -d "$app" ] || { echo "missing macOS app: $app" >&2; exit 1; }
[ -f "$dmg" ] || { echo "missing macOS DMG: $dmg" >&2; exit 1; }

codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"

codesign --verify --verbose=2 "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
xcrun stapler validate "$dmg"

app_authority="$(codesign -dv --verbose=4 "$app" 2>&1 | grep '^Authority=' || true)"
dmg_authority="$(codesign -dv --verbose=4 "$dmg" 2>&1 | grep '^Authority=' || true)"
if ! grep -q 'Developer ID Application' <<<"$app_authority"; then
  echo "macOS app is not signed with Developer ID Application" >&2
  exit 1
fi
if ! grep -q 'Developer ID Application' <<<"$dmg_authority"; then
  echo "macOS DMG is not signed with Developer ID Application" >&2
  exit 1
fi

echo "verified Developer ID signatures, Gatekeeper assessment, and notarization staples for macOS $arch"
