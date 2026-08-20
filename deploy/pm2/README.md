# Manual control-plane deployment with PM2

The VPS process is SourceNerve's **control plane / Desktop Bootstrap Broker**, not a repository data-plane daemon. Operators pull `main`, build the Rust binary, and reload one PM2 process manually.

Repository workspaces, GitHub/GitLab credentials, embeddings, indexing, repository MCP tools, and local bearer secrets belong to each Desktop-managed local daemon and must not be configured on the VPS.

## VPS prerequisites

Install Rust/Cargo, Git, PM2, and CA certificates. The control-plane runtime does not require `gh`, `glab`, `rg`, a checked-out user repository, Git provider tokens, or an OpenAI key.

Runtime configuration lives in the checked-out repository root:

```text
SourceNerve/
├── .env
├── .env.example
├── sourcenerve.toml   # deployment-local when used
└── ...
```

`.env` is local-only and ignored by Git. SourceNerve loads it before runtime selection/configuration. Configuration files use plain `KEY=VALUE` syntax; shell `export KEY=VALUE` lines are rejected.

## First start

```bash
cd /srv/apps/SourceNerve
git checkout main
git pull --ff-only origin main
cargo build --release

cp -n .env.example .env
chmod 600 .env
nano .env

pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
curl -fsS http://127.0.0.1:7331/healthz
curl -fsS http://127.0.0.1:7331/readyz
curl -fsS http://127.0.0.1:7331/v1/desktop/client-config
```

Required control-plane values in `.env` are:

```dotenv
SOURCENERVE_CONFIG=sourcenerve.toml
SOURCENERVE_OAUTH_ISSUER=https://YOUR_AUTH0_TENANT/
SOURCENERVE_OAUTH_RESOURCE=https://YOUR_PUBLIC_DOMAIN/mcp
SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER=false
SOURCENERVE_AUTH0_NATIVE_CLIENT_ID=replace-with-auth0-native-application-client-id
SOURCENERVE_DESKTOP_BROKER_ENABLED=true
SOURCENERVE_CLOUDFLARE_ACCOUNT_ID=replace-with-cloudflare-account-id
SOURCENERVE_CLOUDFLARE_ZONE_ID=replace-with-cloudflare-zone-id
SOURCENERVE_CLOUDFLARE_API_TOKEN=replace-with-scoped-cloudflare-api-token
SOURCENERVE_DESKTOP_HOSTNAME_SUFFIX=mcp.sourcenerve.fogewise.io.vn
```

`SOURCENERVE_OAUTH_ISSUER`, `SOURCENERVE_OAUTH_RESOURCE`, and `SOURCENERVE_AUTH0_NATIVE_CLIENT_ID` are owned by the backend deployment. Desktop does not hardcode or require those values in its own `.env`; it fetches them from `GET /v1/desktop/client-config` before initializing Auth0.

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
curl -fsS http://127.0.0.1:7331/v1/desktop/client-config
```

No shell `source` or `export` step is part of the deployment contract. SourceNerve reads `.env` itself on every process start/reload.

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
Auth0 public client configuration
Auth0 token validation
Desktop installation enrollment/status/revoke/rotation
Cloudflare tunnel + DNS provisioning
installation routing metadata in server SQLite
health/readiness + optional observability
```

Desktop data plane on each user's machine:

```text
selected repository/workspace
GitHub authentication owned by gh CLI
GitLab authentication owned by glab CLI
local bearer
local SQLite/index/semantic state
repository MCP/tools and mutations
```

Desktop receives only the public Auth0 issuer, audience/resource, and Native Application client ID from the control plane. Provider login credentials remain owned by `gh`/`glab` on the user's machine.

## Desktop packages

`.github/workflows/desktop-distribution-smoke.yml` builds Fedora x64 RPM/AppImage, Windows x64 NSIS, macOS arm64 DMG/ZIP, and macOS x64 DMG/ZIP candidates. Stable production signing/notarization and immutable releases remain tag-driven through `Desktop Stable Release` (`desktop-vX.Y.Z`).
