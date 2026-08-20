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

`npm run package` creates the unpacked Electron application for the current native platform. `npm run make` creates the Forge-managed distribution artifacts for Linux/macOS after building/staging the matching Rust daemon and pinned cloudflared runtime. Windows first runs `npm run package`, then `npm run make:nsis -- x64` with the system NSIS compiler.

## Distribution targets

- Fedora/Linux x64: RPM + AppImage.
- Windows x64: NSIS installer.
- macOS arm64/x64: DMG + ZIP.

The GitHub `Desktop Distribution Smoke` workflow builds each target on a native matching runner. macOS x64 uses the Intel runner rather than cross-packaging an arm64 daemon. Linux uses Forge's RPM maker plus the minimal `@reforged/maker-appimage` maker backed by system `mksquashfs`; Windows uses a repository-owned NSIS script instead of pulling the full electron-builder packaging dependency graph. Distribution artifacts are checked in `out/make`, while the unpacked application payload still passes the secret/user-state/native-runtime checks from the Desktop packaged quality gate.

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

## macOS signing/notarization hook

Packaging is unsigned in normal PR builds. The Forge config exposes protected release hooks only when the corresponding environment values are supplied:

- `SOURCENERVE_MACOS_SIGN_IDENTITY`
- `SOURCENERVE_APPLE_ID`
- `SOURCENERVE_APPLE_ID_PASSWORD`
- `SOURCENERVE_APPLE_TEAM_ID`

The signing identity enables hardened-runtime signing with `assets/entitlements.mac.plist`; all three Apple notarization values must be present before notarization is enabled. Production secret storage, verification/stapling and Windows Authenticode policy are owned by #82 and must remain isolated from normal PR/fork builds.
