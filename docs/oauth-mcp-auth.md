# SourceNerve MCP OAuth/OIDC authorization

SourceNerve keeps one MCP runtime: the Streamable HTTP endpoint at `/mcp`. OAuth mode makes that endpoint an OAuth resource server; SourceNerve does not become an authorization server.

Production resource:

```text
https://sourcenerve.fogewise.io.vn/mcp
```

## Modes

When `[oauth]` is omitted, `/mcp` keeps the private/operator `Authorization: Bearer <SOURCENERVE_BEARER_TOKEN>` contract. `/api/v1/*` always remains operator-bearer protected.

Public plugin deployments enable OAuth:

```toml
[oauth]
issuer = "https://YOUR_AUTH0_DOMAIN/"
resource = "https://sourcenerve.fogewise.io.vn/mcp"
allow_operator_bearer = false
max_token_lifetime_seconds = 300

[[oauth.grant]]
subject = "auth0|USER_ID"
workspace = "example"
access = "read-only"

[[oauth.grant]]
subject = "auth0|ANOTHER_USER_ID"
workspace = "example"
access = "read-write"
```

Environment overrides are available for deployment-specific URLs:

```bash
export SOURCENERVE_OAUTH_ISSUER='https://YOUR_AUTH0_DOMAIN/'
export SOURCENERVE_OAUTH_RESOURCE='https://sourcenerve.fogewise.io.vn/mcp'
```

Do not enable `SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER` on the public endpoint unless a deliberate migration window requires it. OAuth tokens and repository-host/Git credentials are separate credentials; an OAuth token is never reused as a GitHub/GitLab token or Git credential.

## Authorization model

A valid access token grants no workspace access until its exact OIDC `sub` has a matching `[[oauth.grant]]` entry.

SourceNerve requires `sourcenerve:read` for MCP access. Source mutation, task mutation, indexing/state changes, Git actions, and repository-provider writes additionally require:

1. `sourcenerve:write` in the access token;
2. `access = "read-write"` for the exact subject/workspace grant; and
3. the configured workspace itself to be writable.

A read-write OAuth grant never overrides an operator-configured read-only workspace. Task/job tools resolve durable IDs back to their persisted workspace before authorization. Workspace listing/readiness is filtered to prevent one OAuth user from discovering another user's ungranted workspaces. State-backup MCP tools remain operator-only.

## Standards surface

When OAuth is enabled SourceNerve publishes protected-resource metadata at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

An unauthenticated `/mcp` request returns `401` with a `WWW-Authenticate: Bearer` challenge containing the `resource_metadata` URL and required read scope. SourceNerve discovers the configured OIDC issuer through `/.well-known/openid-configuration`, fetches bounded JWKS metadata, and validates RS256 signature, exact issuer, MCP resource audience, expiry, issued-at lifetime, and subject.

Tokens for a different resource/audience are rejected.

## Auth0 reference setup

The repository includes an idempotent Auth0 provisioning script. Use a Management API token with only the permissions needed for tenant settings, resource servers, and client grants.

For long Management API JWTs, avoid terminal input methods that can truncate a pasted line. A local clipboard helper is one option:

```bash
export AUTH0_DOMAIN='YOUR_AUTH0_DOMAIN'
export AUTH0_MGMT_TOKEN="$(wl-paste --no-newline)"
bash ./scripts/provision-auth0-mcp.sh
unset AUTH0_MGMT_TOKEN
```

Never commit or paste the Management API token into documentation, config, issues, or CI logs.

The script configures:

1. RFC 8707 resource-parameter compatibility;
2. a SourceNerve API whose Identifier is exactly `https://sourcenerve.fogewise.io.vn/mcp`;
3. RS256 signing;
4. scopes `sourcenerve:read` and `sourcenerve:write`;
5. offline-access/refresh-token eligibility;
6. a short 300-second access-token lifetime by default;
7. a default user-delegated third-party client grant for SourceNerve scopes; and
8. Dynamic Client Registration with strict security mode after the default grant exists.

After provisioning, add only approved Auth0 user IDs/OIDC subjects to the server TOML. A template is included at `deploy/oauth/sourcenerve.oauth.toml.example`.

## Revocation boundary

Auth0 custom-API access tokens are self-contained JWTs. Revoking a refresh token prevents new access tokens but does not retroactively invalidate an already-issued JWT before its expiry. SourceNerve therefore validates signature/issuer/audience/expiry and also rejects access tokens whose declared `exp - iat` exceeds `max_token_lifetime_seconds`.

Keep the Auth0 API token lifetime aligned with the short SourceNerve bound and use refresh tokens for renewable client sessions.

## Production transport: Cloudflare Tunnel

The production SourceNerve process runs on the SourceNerve host and remains bound to loopback:

```toml
[server]
bind = "127.0.0.1:7331"
```

Cloudflare Tunnel publishes the public hostname without exposing port `7331` or requiring a VPS reverse proxy:

```text
sourcenerve.fogewise.io.vn
  -> Cloudflare Tunnel
  -> http://127.0.0.1:7331
```

The authoritative transport runbook is `deploy/cloudflare/README.md`. The tunnel must preserve the incoming OAuth `Authorization` header. Do not inject the operator bearer token and do not put a second authentication layer in front of `/mcp` that consumes the Auth0 bearer.

## Server activation

After merging/deploying a release that changes Rust source:

```bash
cd /home/khovan/Workplaces/SourceNerve
git switch main
git pull --ff-only origin main
cargo build --release
```

Restart the SourceNerve process/service that owns the configured local workspaces and server-side provider credentials.

The Auth0 Management API token is a provisioning credential only. It must not be present in the normal SourceNerve runtime environment.

## Verification

OAuth preflight:

```bash
export SOURCENERVE_OAUTH_ISSUER='https://YOUR_AUTH0_DOMAIN/'
bash ./scripts/verify-oauth-deployment.sh
```

Manual checks:

```bash
curl -fsS https://sourcenerve.fogewise.io.vn/healthz | jq
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp | jq
curl -i https://sourcenerve.fogewise.io.vn/mcp
```

The final request must return `401` and a `WWW-Authenticate` challenge containing the exact protected-resource metadata URL.

Authorization testing should include:

- valid read token + granted workspace: read succeeds;
- token for another audience: `401`;
- expired token: `401`;
- token without `sourcenerve:read`: `403`;
- subject without workspace grant: workspace-scoped tool denied;
- read-only grant attempting mutation: denied;
- subject A targeting subject B's workspace: denied;
- legacy operator token rejected on public `/mcp` when `allow_operator_bearer = false`, while `/api/v1` remains operator-bearer protected.

## Public plugin activation

The public plugin submission uses:

```text
MCP URL type: Universal
MCP URL: https://sourcenerve.fogewise.io.vn/mcp
Authentication: OAuth
```

SourceNerve also serves the publication website, privacy, terms, support, and OpenAI domain challenge endpoint. See `docs/plugin-submission.md` for the portal checklist and reviewer test cases.

Do not invent an OpenAI OAuth client ID, callback URL, verified publisher identity, or domain challenge token. Use the exact values and identity shown by the current OpenAI submission flow.
