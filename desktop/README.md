# SourceNerve Desktop

This directory contains the Electron Forge + React/Vite/TypeScript Desktop application.

| Area | Boundary |
| --- | --- |
| **Main process** | Trusted runtime, daemon bootstrap, native windows, provider credentials, and file/process authority. |
| **Preload bridge** | Narrow typed IPC surface only; no general Node.js access. |
| **Renderer** | React presentation layer for Harness chat, workspaces, plugins, MCP, PRs, diagnostics, and settings. |
| **Managed runtime** | Staged Rust daemon, cloudflared, plugin catalog, release checks, and packaged quality verification. |

```text
Desktop shell
  ├─ Workspaces          Configure guarded repositories
  ├─ Harness             ChatGPT / Codex / Goal / Loop conversations
  ├─ Plugins + MCP       Skills, extension schemas, and connections
  ├─ Pull Requests       Provider-backed review lifecycle
  └─ Diagnostics         Logs, readiness, recovery, and release checks
```

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

SourceNerve account authentication is not required by Desktop. The personal ChatGPT connector uses the installation-scoped Public MCP URL with No Auth. GitHub/GitLab repository authentication remains owned by the external `gh`/`glab` credential stores.

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

The GitHub `Desktop Distribution` workflow builds each target on a native matching runner. The workflow writes an ephemeral `desktop/.env` before product-profile materialization; it does not provide repository-provider credentials to the Desktop build.

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
- MCP
- Plugins
- Harness
- Pull Requests
- Connections
- Logs & Diagnostics
- Settings

## Theme

System/light/dark color tokens are defined in `src/renderer/styles.css`.

## Icons and installer metadata

`assets/icon.svg` is the editable SourceNerve application mark. `npm run icons:generate` renders platform PNG/ICO/ICNS files into ignored `assets/generated/` output before dev/package/make. The macOS bundle ID is `io.fogewise.sourcenerve.desktop`.

The repository-owned NSIS installer is per-user, registers the same callback protocol, creates Start Menu/Desktop shortcuts, and removes only the installed program directory during uninstall. SourceNerve application data remains outside that directory and is preserved by default.

Per-install SourceNerve bearer/workspace state is generated after installation and is never baked into distribution artifacts. GitHub/GitLab login remains owned by the user's external `gh`/`glab` credential stores.

## Stable release artifact policy

Normal PR, fork, local, `Desktop Distribution`, and tag-triggered `Desktop Stable Release` builds are allowed to produce unsigned artifacts. Stable publishing still runs behind the protected `desktop-release` GitHub environment and keeps the existing version, security, packaged-payload, checksum, updater-manifest, and immutable-release gates.

Stable targets are:

- Fedora/Linux x64: RPM + AppImage.
- Windows x64: NSIS installer.
- macOS arm64: DMG + ZIP.
- macOS x64: DMG + ZIP.

No Authenticode certificate, Apple Developer ID certificate, Apple ID, or notarization credential is required to build or publish these artifacts. On end-user machines, Windows SmartScreen and macOS Gatekeeper may show warnings for unsigned/non-notarized downloads; this is expected and does not prevent CI from producing the installers.

The repository retains the macOS and Windows signing helper scripts for an optional future signed channel. They are not invoked by the unsigned stable pipeline and their secrets must never be required for ordinary artifact builds.

## Credential rotation

Git provider credential rotation is handled by `gh`/`glab`. Bootstrap Broker URL changes require a new Desktop package because that URL is the initial discovery location. If an optional signed channel is enabled later, signing credential rotation requires a new signed release.
