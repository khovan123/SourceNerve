# Desktop identity and Git provider authentication

SourceNerve Desktop intentionally separates product identity from repository-provider authentication.

## SourceNerve identity: Auth0 Native Application

Desktop remains an Auth0 public/native client using Authorization Code + PKCE.

Required Auth0 application settings:

- Application type: Native.
- Allowed callback URL: `sourcenerve://oauth/callback`.
- Audience/API identifier: `https://sourcenerve.fogewise.io.vn/mcp`.
- Issuer: `https://dev-fogewise.jp.auth0.com/`.
- Grant types: Authorization Code and Refresh Token.
- No client secret is distributed to Desktop.

The release profile requires only the public Auth0 Native Application client ID through `SOURCENERVE_AUTH0_NATIVE_CLIENT_ID` plus the public bootstrap broker URL through `SOURCENERVE_BOOTSTRAP_BROKER_URL`.

## GitHub: GitHub CLI owns authentication

SourceNerve does not register or ship a GitHub OAuth client ID and does not implement GitHub Device Flow.

Install and authenticate GitHub CLI outside SourceNerve:

```bash
gh auth login --hostname github.com
```

For HTTPS Git remotes, configure Git to use the authenticated GitHub CLI credential helper:

```bash
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

- `gh` / `glab` own provider login and their credential storage.
- SourceNerve never invokes provider logout as a side effect of disconnecting its UI state.
- SourceNerve provider metadata stores account identity only, never provider tokens.
- Electron Main may ask the authenticated CLI for a token immediately before materializing/restarting the local Rust daemon because the current Rust provider clients still accept `SOURCENERVE_GITHUB_TOKEN` / `SOURCENERVE_GITLAB_TOKEN` at the process boundary.
- Those transient values are redacted from logs, are not written to generated TOML, and are not persisted by the Desktop secure store.
- Ambient shell variables such as `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, and `OAUTH_TOKEN` are not forwarded into provider CLI subprocesses; Desktop intentionally uses the CLI-managed session.

## Fedora development setup

```bash
sudo dnf install -y gh
# Install glab using the GitLab-supported package/repository for your Fedora version.

gh auth login --hostname github.com
gh auth setup-git --hostname github.com
glab auth login --hostname gitlab.com
```

Then materialize only the SourceNerve deployment values:

```bash
export SOURCENERVE_AUTH0_NATIVE_CLIENT_ID='<auth0-native-client-id>'
export SOURCENERVE_BOOTSTRAP_BROKER_URL='https://sourcenerve.fogewise.io.vn'

cd desktop
node scripts/materialize-product-profile.mjs
npm run dev
```

There are no `SOURCENERVE_GITHUB_OAUTH_CLIENT_ID` or `SOURCENERVE_GITLAB_OAUTH_CLIENT_ID` values in this architecture.
