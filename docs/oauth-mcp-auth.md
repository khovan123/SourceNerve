# SourceNerve MCP OAuth/OIDC authorization

SourceNerve keeps one MCP runtime: the existing Streamable HTTP endpoint at `/mcp`. OAuth mode makes that endpoint an OAuth resource server; it does not embed or proxy an authorization server.

The production MCP resource for the Fogewise deployment is:

```text
https://sourcenerve.fogewise.io.vn/mcp
```

## Modes

### Private/operator mode

When `[oauth]` is omitted, `/mcp` keeps the existing `Authorization: Bearer <SOURCENERVE_BEARER_TOKEN>` contract. `/api/v1/*` always keeps this operator-bearer contract.

### Public OAuth mode

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

Environment overrides are available for the deployment-specific URLs:

```bash
export SOURCENERVE_OAUTH_ISSUER='https://YOUR_AUTH0_DOMAIN/'
export SOURCENERVE_OAUTH_RESOURCE='https://sourcenerve.fogewise.io.vn/mcp'
```

Do not enable `SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER` on the public endpoint unless a deliberate migration window requires the legacy operator credential. OAuth and repository-host credentials are separate: an OAuth token is never used as a GitHub/GitLab token or Git credential.

## Authorization model

A valid access token grants nothing until its exact OIDC `sub` has an `[[oauth.grant]]` entry.

SourceNerve requires the `sourcenerve:read` scope for MCP access. Source mutation, task mutation, indexing/state mutation, Git actions and repository-host write actions additionally require:

1. `sourcenerve:write` in the access token;
2. `access = "read-write"` for the target workspace; and
3. the workspace itself to be configured `access = "read-write"`.

A read-write OAuth grant never overrides an operator-configured read-only workspace. Task/job tools resolve their durable `task_id`/`job_id` back to the persisted workspace before authorization. `workspace_list` and readiness are filtered so one user does not learn other configured workspace IDs. State backup MCP tools remain operator-only.

## Standards surface

When OAuth is enabled SourceNerve publishes protected-resource metadata at both:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

An unauthenticated `/mcp` request returns `401` with a `WWW-Authenticate: Bearer` challenge containing the `resource_metadata` URL and required read scope. SourceNerve discovers the configured OIDC issuer through `/.well-known/openid-configuration`, fetches bounded JWKS metadata, and validates RS256 signature, issuer, MCP resource audience, expiry, issued-at lifetime and subject.

The configured resource must be the absolute HTTPS URI of the existing `/mcp` endpoint. Tokens issued for another audience/resource are rejected.

## Auth0 reference setup

The repository includes an idempotent Auth0 provisioning script:

```bash
export AUTH0_DOMAIN='YOUR_AUTH0_DOMAIN'
read -rsp 'Auth0 Management API token: ' AUTH0_MGMT_TOKEN
export AUTH0_MGMT_TOKEN
./scripts/provision-auth0-mcp.sh
unset AUTH0_MGMT_TOKEN
```

The Management API token must be limited to the permissions required by the script: tenant settings read/update, resource servers read/create/update, and client grants read/create/update.

The script configures:

1. RFC 8707 resource-parameter compatibility;
2. strict Dynamic Client Registration plus the tenant DCR flag;
3. an Auth0 API whose Identifier is exactly `https://sourcenerve.fogewise.io.vn/mcp`;
4. RS256 signing;
5. scopes `sourcenerve:read` and `sourcenerve:write`;
6. offline access / refresh-token eligibility;
7. a short 300-second access-token lifetime by default; and
8. a default user-delegated third-party client grant for both SourceNerve scopes.

Allowing both scopes at the Auth0 client-grant layer does not authorize every user to mutate repositories. SourceNerve still requires the exact OIDC `sub` to have a server-side `read-write` grant for the target workspace, and the workspace itself must be configured writable.

After the Auth0 API is provisioned, obtain each approved user's exact Auth0 `user_id`/OIDC `sub` and add it to the server SourceNerve TOML. A production snippet is included at `deploy/oauth/sourcenerve.oauth.toml.example`.

## Revocation boundary

Auth0 custom-API access tokens are self-contained JWTs. An already-issued JWT access token remains usable until `exp`; refresh-token revocation prevents new access tokens but does not retroactively invalidate a JWT that has already been issued.

SourceNerve therefore fails closed in two layers:

- signature/issuer/audience/expiry validation rejects invalid or expired JWTs;
- `max_token_lifetime_seconds` rejects access tokens whose declared `exp - iat` exceeds the configured maximum.

Keep the Auth0 API token lifetime at the same short bound, recommended 300 seconds, and use refresh tokens.

## Fogewise VPS domain and Caddy

The Fogewise VPS uses Caddy. Keep SourceNerve bound to loopback:

```toml
[server]
bind = "127.0.0.1:7331"
```

The repository contains the production Caddy site block at:

```text
deploy/caddy/sourcenerve.Caddyfile
```

Append that site block to the existing `/etc/caddy/Caddyfile`, then validate and reload:

```bash
cd /home/khovan/Workplaces/SourceNerve
sudo sh -c 'cat deploy/caddy/sourcenerve.Caddyfile >> /etc/caddy/Caddyfile'
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The site block proxies `sourcenerve.fogewise.io.vn` to `127.0.0.1:7331` and flushes Streamable HTTP MCP responses immediately. Caddy preserves normal request headers through `reverse_proxy`; do not replace the OAuth `Authorization` bearer with the operator bearer at the proxy.

The existing `*.fogewise.io.vn` DNS record can resolve this hostname to the Fogewise VPS. If Cloudflare proxying prevents Caddy from obtaining or renewing the origin certificate, create an explicit `sourcenerve` A record to the same VPS and temporarily set that record to DNS-only while Caddy completes certificate issuance, then re-enable proxying after the origin serves HTTPS correctly.

Do not expose port `7331` publicly.

## Server activation after merge

Do not deploy the OAuth config with an old SourceNerve binary. After pulling the merged code:

```bash
cd /home/khovan/Workplaces/SourceNerve
git switch main
git pull --ff-only origin main
cargo build --release
```

Merge the OAuth snippet into the server's existing SourceNerve config:

```toml
[oauth]
issuer = "https://YOUR_AUTH0_DOMAIN/"
resource = "https://sourcenerve.fogewise.io.vn/mcp"
allow_operator_bearer = false
max_token_lifetime_seconds = 300
```

Add only approved `[[oauth.grant]]` entries, then restart SourceNerve using the VPS service/container mechanism that owns the repository and Git credentials.

The Auth0 Management API token is a provisioning credential only. Do not put it in the SourceNerve runtime environment, TOML, GitHub Actions secrets, logs, or MCP configuration.

## Verification

The repository includes a public deployment preflight:

```bash
export SOURCENERVE_OAUTH_ISSUER='https://YOUR_AUTH0_DOMAIN/'
./scripts/verify-oauth-deployment.sh
```

It verifies public `healthz`, RFC 9728 metadata and the exact production resource, the unauthenticated `/mcp` `401` OAuth discovery challenge, and OIDC discovery with `offline_access` when the issuer is supplied.

Manual equivalents:

```bash
curl -fsS https://sourcenerve.fogewise.io.vn/healthz | jq
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp | jq
curl -i https://sourcenerve.fogewise.io.vn/mcp
```

The final command must return `401` and a `WWW-Authenticate` challenge containing the protected-resource metadata URL.

Test both positive and negative authorization paths:

- valid read token + granted workspace: read succeeds;
- token for another audience: `401`;
- expired token: `401`;
- token without `sourcenerve:read`: `403`;
- subject without a workspace grant: workspace-scoped tool denied;
- read-only grant attempting mutation: tool denied;
- subject A targeting subject B's workspace: denied;
- OAuth configured with `allow_operator_bearer = false`: legacy operator token rejected on `/mcp` while `/api/v1` still accepts the operator bearer.

## ChatGPT app activation

For ChatGPT MCP apps, configure the app with:

```text
https://sourcenerve.fogewise.io.vn/mcp
```

Use OAuth authentication and complete the provider flow during tool scanning. The OIDC provider must advertise `offline_access` and issue refresh tokens so the connection can be renewed without repeated login.

Do not invent an OpenAI OAuth client ID or callback URL. Use the exact values/flow presented by the current ChatGPT app setup UI or the MCP registration mechanism used by the client.
