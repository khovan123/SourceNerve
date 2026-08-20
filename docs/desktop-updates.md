# SourceNerve Desktop update contract

This document defines the stable Desktop update behavior implemented by issue #77. Publication/signing remain separate gates owned by #78 and #82.

## Product unit

A SourceNerve Desktop release is one compatibility unit:

- Electron Desktop application version.
- Bundled SourceNerve Rust daemon with the same version.
- Bundled public product bootstrap profile.
- Bundled cloudflared runtime selected by the packaging pipeline.

The managed daemon is never updated independently from the Desktop package. Local/headless SourceNerve installations do not use the Desktop updater.

## Stable channel

The user-visible channel is `stable`. The runtime maps it to architecture-specific electron-updater channels so native artifacts cannot overwrite each other's metadata:

- Windows x64: `latest-x64.yml`.
- Linux x64: `latest-x64-linux.yml`.
- macOS x64: `latest-x64-mac.yml`.
- macOS arm64: `latest-arm64-mac.yml`.

The channel files are generated from the final installer artifacts. Every listed file includes a SHA-512 digest and byte size. The same metadata carries SourceNerve compatibility fields:

```yaml
sourcenerve:
  daemonVersion: "0.2.0"
  profileSchemaVersion: 1
```

The client refuses a stable update when the target is not a newer stable SemVer, the daemon version differs from the Desktop version, or the profile schema is not supported by the running client.

## Runtime flow

1. Settings requests a check through typed preload IPC.
2. The Electron main process queries public GitHub Releases through `electron-updater`.
3. Compatibility metadata is validated before download is offered.
4. Download progress is emitted to the Settings UI.
5. The downloaded artifact is verified by electron-updater against the SHA-512 channel metadata.
6. `Restart to update` delegates installation to the native updater path.
7. On the next launch, existing Desktop bootstrap still verifies that the bundled daemon version equals `app.getVersion()` before managed runtime startup.

Renderer code never downloads or executes installers directly.

## Platform behavior

### Windows

The x64 NSIS installer is per-user. Update installation is silent and the installer relaunches SourceNerve after a successful silent install. The installer replaces application files only. SourceNerve user data remains under Electron user-data/managed/secure/state paths outside the install directory.

### macOS

The update artifact is the architecture-matching ZIP; DMG remains the first-install artifact. electron-updater uses the macOS update helper for the bundle replacement. Production auto-update is not considered releasable until the #82 signing/notarization gate is satisfied.

### Linux

AppImage installations use the AppImage updater path. RPM installations use the RPM updater path. The same `latest-x64-linux.yml` can list both files; the running updater selects the artifact family matching the installation.

## State and credential preservation

Updates do not rewrite the managed workspace registry, Auth0 session, Git provider sessions, installation identity, local bearer, or user state. Those values live outside the application payload and remain owned by the existing secure-store/bootstrap managers.

The local SourceNerve bearer remains installation-scoped. A release must never replace it with a shared release-wide bearer. If a future state/bootstrap migration requires bearer rotation, the migration must explicitly generate a new installation-local bearer in secure storage and update the managed runtime atomically.

Cloudflare/Public MCP installation credentials are also not embedded into update metadata or renderer assets. When product routing defaults change, the packaged public profile may change without user input. If an installation credential must rotate, rotation occurs after launch through the existing authenticated bootstrap-broker `rotateTunnelPath` flow; the old credential is revoked only after the replacement has been stored successfully. Account-level Cloudflare API tokens are never delivered to Desktop.

Auth0 identity and Git provider identity remain independent through the update because neither session is re-created from release metadata.

## Recovery

- A failed download leaves the installed application untouched.
- A rejected/incompatible manifest leaves the installed application untouched and surfaces an `incompatible` state in Settings.
- User workspace/state/secure-store data is outside the install directory and survives installer replacement or uninstall by default.
- If a new bundled daemon cannot open existing state, startup remains blocked by the existing daemon/bootstrap readiness and recovery tooling; users can validate backups/rebuild indexes without losing provider sessions.
- A broken stable release is never repaired by reusing the same version number or by downgrading metadata. Publish a higher fixed version so updater monotonicity remains intact.

## Release pipeline handoff

Issue #78 must collect the native artifacts and architecture-specific channel files produced by `Desktop Distribution Smoke`, publish them to the same GitHub Release, and block stable publication when secret scan, version compatibility, packaged smoke or required signing gates fail.

Issue #82 owns production macOS Developer ID/notarization and Windows Authenticode policy. PR builds remain free of signing credentials.
