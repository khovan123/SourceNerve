# Manual backend deployment with PM2

The SourceNerve backend is intentionally **not deployed by GitHub Actions**. Desktop CI and backend operations are separate:

- a push to the default branch builds Desktop installer artifacts for Fedora, Windows, and macOS;
- the VPS backend is updated manually by pulling the repository, building the Rust release binary, and reloading the single PM2 process.

## VPS prerequisites

Install Rust/Cargo, Git, PM2, and the runtime tools required by SourceNerve (`git`, `gh`, `rg`, and `curl`).

Production runtime files live in the checked-out repository root:

```text
SourceNerve/
├── sourcenerve.toml
├── sourcenerve.env
└── ...
```

`sourcenerve.toml` is tracked and contains non-secret runtime configuration. `sourcenerve.env` is local-only, ignored by Git, and contains secrets plus environment-only runtime options.

SourceNerve automatically loads `./sourcenerve.env` before logging, TOML configuration, provider runtimes, webhook configuration, and other environment-backed features are initialized. Existing PM2/system environment variables take precedence over values in the file.

To use a different env-file path, set `SOURCENERVE_ENV_FILE` in the process environment before SourceNerve starts. If no override is provided, `./sourcenerve.env` is used. A missing env file is allowed; an existing malformed/unreadable env file fails startup.

## First start

From the checked-out repository root:

```bash
cd /srv/apps/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release

cp -n sourcenerve.env.example sourcenerve.env
chmod 600 sourcenerve.env
# Edit sourcenerve.env and replace the bearer/provider secret placeholders.

pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
curl -fsS http://127.0.0.1:7331/healthz
```

At minimum, set a production bearer token in `sourcenerve.env`:

```bash
SOURCENERVE_BEARER_TOKEN=<at-least-24-characters>
```

Generate one with:

```bash
openssl rand -hex 32
```

The root `sourcenerve.toml` uses `root = "."` for the default SourceNerve workspace, so PM2's repository-root working directory resolves correctly on the VPS.

`ecosystem.config.cjs` intentionally runs exactly one SourceNerve process. Do not switch it to PM2 cluster mode or multiple instances against the same workspace/state directory.

## Manual update after a merge

```bash
cd /srv/apps/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release
pm2 startOrReload deploy/pm2/ecosystem.config.cjs
curl -fsS http://127.0.0.1:7331/healthz
```

No `source`, `export`, or `--update-env` step is required for values stored in `sourcenerve.env`; SourceNerve loads the file itself on every process start/reload.

If the configured bind address or port differs from `127.0.0.1:7331`, use that value for the health check.

Useful operations:

```bash
pm2 status sourcenerve-backend
pm2 logs sourcenerve-backend
pm2 restart sourcenerve-backend
```

## Runtime configuration boundary

Use `sourcenerve.toml` for normal SourceNerve configuration such as server bind, storage, OAuth issuer/resource/grants, and workspaces.

Use `sourcenerve.env` for secrets and environment-only integrations such as:

- `SOURCENERVE_BEARER_TOKEN`
- `SOURCENERVE_GITHUB_TOKEN`
- `SOURCENERVE_GITLAB_TOKEN`
- `SOURCENERVE_OPENAI_API_KEY`
- webhook/callback secrets
- optional metrics/OpenTelemetry settings

Do not commit `sourcenerve.env`.

## Desktop post-merge packages

`.github/workflows/desktop-distribution-smoke.yml` runs on pushes to `main` and produces deterministic CI build candidates with the repository-owned non-production distribution profile. It does not depend on production OAuth/broker Actions variables and it does not sign or notarize stable production artifacts.

The post-merge workflow builds Fedora x64 RPM/AppImage, Windows x64 NSIS, macOS arm64 DMG/ZIP, and macOS x64 DMG/ZIP. Stable production public profile values, signing/notarization credentials, and the immutable stable release path remain isolated to the tag-driven `Desktop Stable Release` workflow (`desktop-vX.Y.Z`).
