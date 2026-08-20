# SourceNerve Desktop

This directory contains the Electron Forge + React/Vite/TypeScript desktop application defined by the Desktop milestone.

## Commands

```bash
cd desktop
npm install
npm run dev
npm run typecheck
npm test
npm run package
npm run make
```

`npm run package` creates the unpacked Electron application for the current native platform. `npm run make` creates the Forge-managed distribution artifacts for Linux/macOS after building/staging the matching Rust daemon and pinned cloudflared runtime. On macOS, Forge produces the initial ZIP and `npm run make:dmg -- <arch>` wraps the already packaged `.app` into a compressed DMG with native `hdiutil`. Windows first runs `npm run package`, then `npm run make:nsis -- x64` with the system NSIS compiler.

## Distribution targets

- Fedora/Linux x64: RPM + AppImage.
- Windows x64: NSIS installer.
- macOS arm64/x64: DMG + ZIP.

The GitHub `Desktop Distribution Smoke` workflow builds each target on a native matching runner. macOS x64 uses the Intel runner rather than cross-packaging an arm64 daemon. Linux uses Forge's RPM maker plus the minimal `@reforged/maker-appimage` maker backed by system `mksquashfs`; Windows uses a repository-owned NSIS script; macOS uses Forge ZIP plus a repository-owned `hdiutil` DMG wrapper. This avoids pulling the broader electron-builder/appdmg packaging dependency chains into the Desktop dependency tree. Distribution artifacts are checked in `out/make`, while the unpacked application payload still passes the secret/user-state/native-runtime checks from the Desktop packaged quality gate.

## Process boundary

- `src/main.ts`: trusted Electron main process and native window lifecycle.
- `src/preload.ts`: narrow typed bridge only.
- `src/shared/desktop-api.ts`: renderer/main contract.
- `src/renderer/`: React presentation layer with no Node.js API access.

The BrowserWindow enables `contextIsolation`, disables `nodeIntegration`, and enables sandboxing. Renderer code does not construct privileged SourceNerve requests or read environment variables/secrets.

## Navigation

The shell follows `docs/desktop-ux-spec.md`:

- Overview
- Workspaces
- Repository Intelligence
- Tasks & Changes
- Pull Requests
- Connections
- Logs & Diagnostics
- Settings

## Theme

System/light/dark color tokens are defined in `src/renderer/styles.css`.

## Icons and installer metadata

`assets/icon.svg` is the editable SourceNerve application mark. `npm run icons:generate` deterministically renders the platform PNG/ICO/ICNS files into ignored `assets/generated/` output before dev/package/make. Windows/macOS application embedding uses the generated ICO/ICNS; RPM/AppImage use the generated PNG; the macOS bundle ID is `io.fogewise.sourcenerve.desktop`; and the `sourcenerve://` protocol remains registered for the Auth0 callback flow.

The repository-owned NSIS installer is per-user, registers the same callback protocol, creates Start Menu/Desktop shortcuts, and intentionally removes only the installed program directory during uninstall. SourceNerve application data remains outside that directory and is preserved by default. Per-install bearer, Auth0/Git sessions, workspace registry and user state are generated/stored after installation and are never baked into distribution artifacts.

## Stable release signing policy

Normal PR, fork, local, and `Desktop Distribution Smoke` artifacts remain unsigned development artifacts. They are quality-test outputs only and must never be presented as production-ready downloads. Only the tag-triggered `Desktop Stable Release` workflow may publish stable binaries, and its native build jobs run behind the protected `desktop-release` GitHub environment.

### macOS

Production macOS artifacts use a Developer ID Application certificate supplied only through protected release secrets. `scripts/build-signed-macos-release.sh` creates an ephemeral keychain, imports the protected PKCS#12 certificate, lets Electron Packager sign/notarize the `.app`, explicitly staples the app, rebuilds the updater ZIP from that stapled app, creates and signs the DMG, submits the DMG to Apple notarization, staples it, and removes the temporary keychain/certificate on exit. `scripts/verify-macos-signing.sh` then requires all of the following before publication:

- Developer ID Application authority on the standalone `.app`, the `.app` extracted from the updater ZIP, and the DMG;
- hardened-runtime flag on both copies of the app signature;
- `codesign --verify --deep --strict` for both app copies;
- Gatekeeper assessment for both app copies and the DMG;
- valid Apple notarization staples for both app copies and the DMG.

Protected macOS values:

- `SOURCENERVE_MACOS_CERTIFICATE_BASE64`
- `SOURCENERVE_MACOS_CERT_PASSWORD`
- `SOURCENERVE_MACOS_SIGN_IDENTITY`
- `SOURCENERVE_APPLE_ID`
- `SOURCENERVE_APPLE_ID_PASSWORD`
- `SOURCENERVE_APPLE_TEAM_ID`

`assets/entitlements.mac.plist` remains the reviewed entitlement baseline. Electron Packager delegates per-file signing to `@electron/osx-sign`; stable CI validates the resulting hardened artifact instead of bypassing current Packager types with unsupported legacy signing fields.

### Windows

Windows production signing is mandatory for stable launch. The selected policy is Authenticode using a code-signing certificate exported as password-protected PFX/PKCS#12 and stored only in protected `desktop-release` secrets. `scripts/sign-windows-release.ps1` materializes that PFX only in the runner temporary directory, signs with SHA-256 and an RFC3161 timestamp, verifies immediately with `signtool`, and deletes the temporary certificate in `finally`.

The application executable is signed **before** the repository-owned NSIS installer is built, so the installed executable is trusted. The final NSIS installer is then signed separately. `scripts/verify-windows-signing.ps1` requires a valid Authenticode status, a non-expired signer certificate, an RFC3161 timestamp certificate, and Windows trust-policy verification for both files.

Protected Windows values:

- `SOURCENERVE_WINDOWS_CERTIFICATE_BASE64`
- `SOURCENERVE_WINDOWS_CERT_PASSWORD`

If the production certificate is unavailable, the stable release job fails closed. Unsigned Windows artifacts may still be produced by PR/distribution smoke for development diagnosis, but they are not eligible for stable publication.

## Signing credential rotation and recovery

Signing credentials never enter renderer code, application resources, source maps, updater manifests, or Git history. Release CI scans tracked/generated application code against supplied protected signing secret values. To rotate a certificate or notarization credential, replace the corresponding secret in `desktop-release`, leave the old certificate available only as long as needed for already-issued binaries, and trigger the next normal versioned stable tag. No user workspace, Auth0 session, Git provider session, per-install bearer, or Public MCP enrollment is migrated during certificate rotation.

A failed native signing/notarization leg leaves its workflow artifact retained for diagnosis, but `publish` cannot run until every native leg passes. Rerun the failed job after correcting the protected credential/environment. Already-published stable releases are immutable; do not overwrite signed assets under an existing public tag. Create a new patch version if a published artifact must be replaced.
