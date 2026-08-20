# Manual control-plane deployment with PM2

The VPS process is SourceNerve's **control plane / Desktop Bootstrap Broker**, not a repository data-plane daemon. It is intentionally not deployed by GitHub Actions: operators pull `main`, build the Rust binary, and reload one PM2 process manually.

Repository workspaces, GitHub/GitLab credentials, embeddings, indexing, MCP repository tools, and local bearer secrets belong to each Desktop-managed local daemon and must not be configured on the VPS.

## VPS prerequisites

Install Rust/Cargo, Git, PM2, and CA certificates. The control-plane runtime does not require `gh`, `rg`, a checked-out user repository, Git provider tokens, or an OpenAI key.

Runtime files live in the checked-out repository root:

```text
SourceNerve/
├── sourcenerve.toml
├── sourcenerve.env
└── ...
```

`sourcenerve.toml` is tracked and selects `[runtime] mode = "control-plane"`. `sourcenerve.env` is local-only, ignored by Git, and contains the Auth0 + Cloudflare deployment values. SourceNerve automatically loads it before runtime selection/configuration. Existing PM2/system environment variables take precedence.

## First start

```bash
cd /srv/apps/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release

cp -n sourcenerve.env.example sourcenerve.env
chmod 600 sourcenerve.env
nano sourcenerve.env

pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
curl -fsS http://127.0.0.1:7331/healthz
curl -fsS http://127.0.0.1:7331/readyz
```

Required deployment values are:

```text
SOURCENERVE_OAUTH_ISSUER
SOURCENERVE_OAUTH_RESOURCE
SOURCENERVE_DESKTOP_BROKER_ENABLED=true
SOURCENERVE_CLOUDFLARE_ACCOUNT_ID
SOURCENERVE_CLOUDFLARE_ZONE_ID
SOURCENERVE_CLOUDFLARE_API_TOKEN
SOURCENERVE_DESKTOP_HOSTNAME_SUFFIX
```

The control plane intentionally has no `[[workspace]]`, `github.token`, `SOURCENERVE_GITHUB_TOKEN`, `SOURCENERVE_GITLAB_TOKEN`, `SOURCENERVE_OPENAI_API_KEY`, or local data-plane bearer.

## Manual update after a merge

```bash
cd /srv/apps/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release
pm2 startOrReload deploy/pm2/ecosystem.config.cjs
curl -fsS http://127.0.0.1:7331/healthz
curl -fsS http://127.0.0.1:7331/readyz
```

No `source`, `export`, or `--update-env` step is required for values stored in `sourcenerve.env`; SourceNerve loads the file itself on every process start/reload.

Useful operations:

```bash
pm2 status sourcenerve-backend
pm2 logs sourcenerve-backend
pm2 restart sourcenerve-backend
```

`ecosystem.config.cjs` intentionally runs exactly one process.

## Runtime boundary

Control plane on VPS:

```text
Auth0 token validation
Desktop installation enrollment/status/revoke/rotation
Cloudflare tunnel + DNS provisioning
installation routing metadata in server SQLite
health/readiness + optional observability
```

Desktop data plane on each user's machine:

```text
selected repository/workspace
GitHub/GitLab credentials in OS secure storage
local bearer
local SQLite/index/semantic state
repository MCP/tools and mutations
```

The two runtimes share the Rust binary but have separate startup paths. Desktop-generated TOML defaults to data-plane mode; the tracked VPS TOML explicitly selects control-plane mode.

## Desktop post-merge packages

`.github/workflows/desktop-distribution-smoke.yml` runs on pushes to `main` and builds Fedora x64 RPM/AppImage, Windows x64 NSIS, macOS arm64 DMG/ZIP, and macOS x64 DMG/ZIP candidates. Stable production signing/notarization and immutable releases remain tag-driven through `Desktop Stable Release` (`desktop-vX.Y.Z`).
