#!/usr/bin/env bash
set -euo pipefail

arch="${1:-}"
case "$arch" in
  arm64|x64) ;;
  *) echo "usage: $0 <arm64|x64>" >&2; exit 2 ;;
esac

required=(
  SOURCENERVE_MACOS_CERTIFICATE_BASE64
  SOURCENERVE_MACOS_CERT_PASSWORD
  SOURCENERVE_MACOS_SIGN_IDENTITY
  SOURCENERVE_APPLE_ID
  SOURCENERVE_APPLE_ID_PASSWORD
  SOURCENERVE_APPLE_TEAM_ID
)
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "missing protected macOS signing value: $name" >&2
    exit 1
  fi
done

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sourcenerve-macos-signing.XXXXXX")"
keychain="$work/sourcenerve-release.keychain-db"
p12="$work/developer-id.p12"
keychain_password="$(uuidgen | tr -d '-')$(uuidgen | tr -d '-')"
original_keychains="$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"

cleanup() {
  set +e
  if [ -n "$original_keychains" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $original_keychains >/dev/null 2>&1
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

python3 - "$p12" <<'PY'
import base64
import os
import sys
value = os.environ["SOURCENERVE_MACOS_CERTIFICATE_BASE64"]
with open(sys.argv[1], "wb") as handle:
    handle.write(base64.b64decode(value, validate=True))
PY

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$p12" -k "$keychain" -P "$SOURCENERVE_MACOS_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# Keep normal runner keychains available while prioritizing the ephemeral release keychain.
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $original_keychains

npm run make -- --arch="$arch"

app="out/SourceNerve-darwin-$arch/SourceNerve.app"
if [ ! -d "$app" ]; then
  echo "signed macOS app was not produced: $app" >&2
  exit 1
fi

# Electron Packager notarizes the app when the Apple credentials are present. Staple and
# validate explicitly so stable release policy never relies on implicit library behavior.
xcrun stapler staple "$app"
xcrun stapler validate "$app"

npm run make:dmg -- "$arch"
version="$(node -p "require('./package.json').version")"
dmg="out/make/dmg/$arch/SourceNerve-$version-$arch.dmg"
if [ ! -f "$dmg" ]; then
  echo "macOS DMG was not produced: $dmg" >&2
  exit 1
fi

codesign --force --timestamp --sign "$SOURCENERVE_MACOS_SIGN_IDENTITY" "$dmg"
xcrun notarytool submit "$dmg" \
  --apple-id "$SOURCENERVE_APPLE_ID" \
  --password "$SOURCENERVE_APPLE_ID_PASSWORD" \
  --team-id "$SOURCENERVE_APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"

bash scripts/verify-macos-signing.sh "$arch"
