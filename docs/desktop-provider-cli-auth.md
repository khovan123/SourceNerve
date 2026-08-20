# Desktop identity and Git provider authentication

SourceNerve Desktop intentionally separates product identity from repository-provider authentication.

## SourceNerve identity: Auth0 Native Application

Desktop remains an Auth0 public/native client using Authorization Code + PKCE.

Required Auth0 application settings are owned by the backend deployment:

- Application type: Native.
- Allowed callback URL: `sourcenerve://oauth/callback`.
- Grant types: Authorization Code and Refresh Token.
- No client secret is distributed to Desktop.

The backend `.env` owns the deployment-specific public Auth0 values:

```dotenv
SOURCENERVE_OAUTH_ISSUER=https://YOUR_AUTH0_TENANT/
SOURCENERVE_OAUTH_RESOURCE=https://YOUR_PUBLIC_DOMAIN/mcp
SOURCENERVE_AUTH0_NATIVE_CLIENT_ID=replace-with-auth0-native-application-client-id
```

Desktop does **not** hardcode or configure those values locally. Before initializing Auth0 it calls:

```text
GET <bootstrap-broker>/v1/desktop/client-config
```

The backend returns the public issuer, audience/resource, Native Application client ID, and protected-resource metadata URL. The returned values are validated before Auth0 login or local daemon materialization proceeds.

## Desktop bootstrap location

Desktop needs one bootstrap location so it knows which backend to ask for configuration. Local development and packaging use `desktop/.env`:

```dotenv
SOURCENERVE_BOOTSTRAP_BROKER_URL=https://sourcenerve.fogewise.io.vn
```

Create it from the tracked example:

```bash
cd desktop
cp -n .env.example .env
node scripts/materialize-product-profile.mjs
npm run dev
```

The materializer reads `desktop/.env` directly. Shell `export KEY=VALUE` syntax is not part of the Desktop configuration contract.

## GitHub: GitHub CLI owns authentication

SourceNerve does not register or ship a GitHub OAuth client ID and does not implement GitHub Device Flow.

Install and authenticate GitHub CLI outside SourceNerve:

```bash
gh auth login --hostname github.com
gh auth setup-git --hostname github.com
```

Verify:

```bash
gh auth status --hostname github.com
gh api --hostname github.com user
```

Desktop detects that existing CLI session and uses `gh api` for account/repository discovery and validation.

## GitLab: GitLab CLI owns authentication

SourceNerve does not register or ship a GitLab OAuth client ID.

Install and authenticate GitLab CLI outside SourceNerve:

```bash
glab auth login --hostname gitlab.com
```

Verify:

```bash
glab auth status --hostname gitlab.com
glab api --hostname gitlab.com user
```

Desktop detects that existing CLI session and uses `glab api` for account/repository discovery and validation.

## Credential boundary

- `gh` / `glab` own provider login and credential storage.
- SourceNerve never logs the user out of either CLI.
- SourceNerve provider metadata stores account identity only, never provider tokens.
- Electron Main may request a provider token transiently from the authenticated CLI immediately before materializing/restarting the local Rust daemon.
- Those transient token values are redacted from logs, are not written to generated TOML, and are not persisted by the Desktop secure store.
- Ambient shell variables such as `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, and `OAUTH_TOKEN` are not forwarded into provider CLI subprocesses; Desktop intentionally uses the CLI-managed session.

## Fedora development setup

```bash
sudo dnf install -y gh
# Install glab using the GitLab-supported package/repository for your Fedora version.

gh auth login --hostname github.com
gh auth setup-git --hostname github.com
glab auth login --hostname gitlab.com

cd ~/Projects/SourceNerve/desktop
cp -n .env.example .env
node scripts/materialize-product-profile.mjs
npm run dev
```

There are no `SOURCENERVE_GITHUB_OAUTH_CLIENT_ID` or `SOURCENERVE_GITLAB_OAUTH_CLIENT_ID` values in this architecture, and Desktop does not require `SOURCENERVE_AUTH0_NATIVE_CLIENT_ID`, issuer, or audience in its own `.env`.
