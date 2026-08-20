# Manual backend deployment with PM2

The SourceNerve backend is intentionally **not deployed by GitHub Actions**. Desktop CI and backend operations are separate:

- a push to the default branch builds Desktop installer artifacts for Fedora, Windows, and macOS;
- the VPS backend is updated manually by pulling the repository, building the Rust release binary, and reloading the single PM2 process.

## VPS prerequisites

Install Rust/Cargo, Git, PM2, and the runtime tools required by SourceNerve (`git`, `gh`, and `rg`). Keep production configuration and secrets outside the repository.

SourceNerve reads `SOURCENERVE_CONFIG` when set and otherwise falls back to `sourcenerve.toml` in the repository root. Runtime secrets such as bearer/provider/webhook credentials must be provided through the VPS environment or a protected config; do not commit them.

## First start

From the checked-out repository root:

```bash
git checkout main
git pull --ff-only origin main
cargo build --release

export SOURCENERVE_CONFIG=/etc/sourcenerve/sourcenerve.toml
# Export any required SOURCENERVE_* secrets from the VPS secret environment here.

pm2 start deploy/pm2/ecosystem.config.cjs --update-env
pm2 save
```

`ecosystem.config.cjs` intentionally runs exactly one SourceNerve process. Do not switch it to PM2 cluster mode or multiple instances against the same workspace/state directory.

## Manual update after a merge

```bash
cd /path/to/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release

export SOURCENERVE_CONFIG=/etc/sourcenerve/sourcenerve.toml
# Refresh required SOURCENERVE_* secrets in this shell before reloading.

pm2 startOrReload deploy/pm2/ecosystem.config.cjs --update-env
curl -fsS http://127.0.0.1:7331/healthz
```

If the configured bind address or port differs from `127.0.0.1:7331`, use that value for the health check.

Useful operations:

```bash
pm2 status sourcenerve-backend
pm2 logs sourcenerve-backend
pm2 restart sourcenerve-backend --update-env
```

## Desktop post-merge packages

`.github/workflows/desktop-distribution-smoke.yml` runs on pushes to `main` and produces deterministic CI build candidates with the repository-owned non-production distribution profile. It does not depend on production OAuth/broker Actions variables and it does not sign, notarize, or publish a stable release.

The post-merge workflow uploads Fedora x64 RPM/AppImage, Windows x64 NSIS, macOS arm64 DMG/ZIP, and macOS x64 DMG/ZIP as GitHub Actions artifacts for 14 days.

Production public profile values, macOS signing/notarization credentials, Windows Authenticode credentials, and GitHub Release publication remain isolated to the existing tag-driven `Desktop Stable Release` workflow (`desktop-vX.Y.Z`).
