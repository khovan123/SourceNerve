# SourceNerve Desktop

This directory contains the Electron Forge + React/Vite/TypeScript Desktop application.

## Local configuration

Desktop build/development configuration is file-based. Create `desktop/.env` from the tracked example:

```bash
cd desktop
cp -n .env.example .env
```

The file contains only the bootstrap backend location:

```dotenv
SOURCENERVE_BOOTSTRAP_BROKER_URL=https://sourcenerve.fogewise.io.vn
```

Do not use shell `export KEY=VALUE` commands for Desktop product configuration. `scripts/materialize-product-profile.mjs` reads `desktop/.env` directly.

Auth0 issuer, audience/resource, Native Application client ID, and Public MCP metadata are **not** configured in Desktop `.env` and are not hardcoded in the distributable profile. On startup Electron Main fetches them from the backend `GET /v1/desktop/client-config` endpoint and validates them before initializing Auth0.

GitHub/GitLab repository authentication is also not configured through Desktop `.env`:

```bash
gh auth login --hostname github.com
gh auth setup-git --hostname github.com
glab auth login --hostname gitlab.com
```

`gh` and `glab` own provider authentication and credential storage.

## Commands

```bash
cd desktop
npm install
node scripts/materialize-product-profile.mjs
npm run dev
npm run typecheck
npm test
npm run package
npm run make
```

`npm run package` creates the unpacked Electron application for the current native platform. `npm run make` creates Forge-managed distribution artifacts for Linux/macOS after building/staging the matching Rust daemon and pinned cloudflared runtime. Windows first runs `npm run package`, then `npm run make:nsis -- x64` with the system NSIS compiler.

## Distribution targets

- Fedora/Linux x64: RPM + AppImage.
- Windows x64: NSIS installer.
- macOS arm64/x64: DMG + ZIP.

The GitHub `Desktop Distribution` workflow builds each target on a native matching runner. The workflow writes an ephemeral `desktop/.env` before product-profile materialization; it does not provide Auth0/GitHub/GitLab OAuth client IDs to the Desktop build.

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

`assets/icon.svg` is the editable SourceNerve application mark. `npm run icons:generate` renders platform PNG/ICO/ICNS files into ignored `assets/generated/` output before dev/package/make. The macOS bundle ID is `io.fogewise.sourcenerve.desktop`; the `sourcenerve://` protocol remains registered for the Auth0 PKCE callback flow.

The repository-owned NSIS installer is per-user, registers the same callback protocol, creates Start Menu/Desktop shortcuts, and removes only the installed program directory during uninstall. SourceNerve application data remains outside that directory and is preserved by default.

Per-install SourceNerve bearer/Auth0 session/workspace state are generated after installation and are never baked into distribution artifacts. GitHub/GitLab login remains owned by the user's external `gh`/`glab` credential stores.

## Stable release signing policy

Normal PR, fork, local, and `Desktop Distribution` artifacts remain unsigned development artifacts. Only the tag-triggered `Desktop Stable Release` workflow may publish stable binaries, and its native build jobs run behind the protected `desktop-release` GitHub environment.

### macOS

Production macOS artifacts use a Developer ID Application certificate supplied only through protected release secrets. `scripts/build-signed-macos-release.sh` creates an ephemeral keychain, imports the protected PKCS#12 certificate, signs/notarizes/staples the app and DMG, rebuilds the updater ZIP from the stapled app, and removes temporary certificate material on exit. `scripts/verify-macos-signing.sh` verifies the final signed/notarized artifacts before publication.

Protected macOS signing values:

- `SOURCENERVE_MACOS_CERTIFICATE_BASE64`
- `SOURCENERVE_MACOS_CERT_PASSWORD`
- `SOURCENERVE_MACOS_SIGN_IDENTITY`
- `SOURCENERVE_APPLE_ID`
- `SOURCENERVE_APPLE_ID_PASSWORD`
- `SOURCENERVE_APPLE_TEAM_ID`

These are CI signing secrets, not Desktop application `.env` configuration.

### Windows

Windows stable releases require Authenticode. `scripts/sign-windows-release.ps1` materializes the protected PFX only in the runner temporary directory, signs with SHA-256/RFC3161 timestamping, verifies it, and deletes the temporary certificate. The application executable is signed before NSIS packaging and the final installer is signed separately.

Protected Windows signing values:

- `SOURCENERVE_WINDOWS_CERTIFICATE_BASE64`
- `SOURCENERVE_WINDOWS_CERT_PASSWORD`

These are CI signing secrets, not Desktop application `.env` configuration.

## Credential rotation

Auth0 issuer/audience/Native client ID rotation occurs on the backend `.env`; Desktop fetches the current public values at runtime. Git provider credential rotation is handled by `gh`/`glab`. Bootstrap Broker URL changes require a new Desktop package because that URL is the initial discovery location. Signing credential rotation requires a new stable release.
