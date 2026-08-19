# SourceNerve Desktop

This directory contains the Electron Forge + React/Vite/TypeScript desktop shell defined by #59.

## Commands

```bash
cd desktop
npm install
npm run dev
npm run typecheck
npm test
npm run package
```

The Desktop application is intentionally a shell at this stage. SourceNerve repository intelligence, mutation, Git/provider and authorization logic remain in the Rust daemon.

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

Feature behavior arrives through the dedicated Desktop issues rather than being mocked into the scaffold.

## Theme

System/light/dark color tokens are defined in `src/renderer/styles.css`. The scaffold includes a local theme-cycle control only to verify token behavior; persisted settings belong to the later Settings implementation.

## Icons and packaging

`assets/icon.svg` is the editable cross-platform source placeholder. #76 owns production `.png`/`.ico`/`.icns`, installer makers and platform packaging metadata. The SourceNerve plugin assets remain separate publication assets.
