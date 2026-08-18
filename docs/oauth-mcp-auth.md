# SourceNerve MCP OAuth/OIDC authorization

SourceNerve keeps one MCP runtime: the existing Streamable HTTP endpoint at `/mcp`. OAuth mode makes that endpoint an OAuth resource server; it does not embed or proxy an authorization server.

## Modes

### Private/operator mode

When `[oauth]` is omitted, `/mcp` keeps the existing `Authorization: Bearer <SOURCENERVE_BEARER_TOKEN>` contract. `/api/v1/*` always keeps this operator-bearer contract.

### Public OAuth mode

Configure an OIDC provider and the canonical public MCP resource URI:

```toml
[oauth]
issuer = "https://YOUR_AUTH0_TENANT.auth0.com/"
resource = "https://sourcenerve.example.com/mcp"
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

Environment overrides are available for the two deployment-specific URLs:

```bash
export SOURCENERVE_OAUTH_ISSUER='https://YOUR_AUTH0_TENANT.auth0.com/'
export SOURCENERVE_OAUTH_RESOURCE='https://sourcenerve.example.com/mcp'
```

Do not enable `SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER` on the public endpoint unless a deliberate migration window requires the legacy operator credential. OAuth and repository-host credentials are separate: an OAuth token is never used as a GitHub/GitLab token or Git credential.

## Authorization model

A valid access token still grants nothing until its exact OIDC `sub` has an `[[oauth.grant]]` entry.

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

An unauthenticated `/mcp` request returns `401` with a `WWW-Authenticate: Bearer` challenge containing the `resource_metadata` URL and the required read scope. SourceNerve discovers the configured OIDC issuer through `/.well-known/openid-configuration`, fetches bounded JWKS metadata, and validates RS256 signature, issuer, MCP resource audience, expiry, issued-at lifetime and subject.

The configured resource must be the absolute HTTPS URI of the existing `/mcp` endpoint. Tokens issued for another audience/resource are rejected.

## Auth0 reference setup

Auth0 is the reference provider for this milestone because its current MCP guidance supports the RFC 8707 `resource` parameter and third-party client registration.

1. Create an Auth0 custom API whose Identifier is exactly your public MCP resource, for example `https://sourcenerve.example.com/mcp`.
2. Use RS256 signing.
3. Add API permissions/scopes `sourcenerve:read` and `sourcenerve:write`.
4. Set the API access-token lifetime to the same or lower value as SourceNerve `oauth.max_token_lifetime_seconds` (300 seconds is the recommended starting point for this deployment).
5. In Auth0 tenant advanced settings, enable **Resource Parameter Compatibility Profile** so RFC 8707 `resource` can select the API audience.
6. Enable refresh-token/offline access and rotating refresh tokens for the client flow. The OIDC discovery document must advertise `offline_access`; SourceNerve refuses startup otherwise.
7. For automatic third-party registration, enable Auth0 Dynamic Client Registration. DCR clients use authorization code + PKCE and refresh tokens. Configure the tenant's third-party/default API permissions so dynamically registered ChatGPT clients are actually allowed to request the SourceNerve API scopes.
8. Alternatively, if the client supports Client ID Metadata Documents, Auth0 can be configured for CIMD registration; do not invent or commit a fake OpenAI client ID.
9. Map each approved Auth0 user's stable `sub` into explicit SourceNerve workspace grants in server configuration. Do not log or return subjects to MCP clients.

Official references:

- MCP authorization specification: `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- Auth0 MCP resource compatibility: `https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile`
- Auth0 Dynamic Client Registration: `https://auth0.com/docs/get-started/applications/dynamic-client-registration`
- OpenAI developer mode / MCP OAuth refresh-token guidance: `https://help.openai.com/en/articles/12584461`

## Revocation boundary

Auth0 custom-API access tokens are self-contained JWTs. Auth0 documents that an already-issued JWT access token cannot be immediately revoked; it remains valid until `exp`. Refresh tokens can be revoked.

SourceNerve therefore fails closed in two layers:

- signature/issuer/audience/expiry validation rejects invalid or expired JWTs;
- `max_token_lifetime_seconds` rejects access tokens whose declared `exp - iat` exceeds the configured maximum.

For Auth0, set the API token lifetime to the same short bound (recommended 300 seconds) and use refresh-token rotation. Revoking the refresh grant prevents new access tokens; any already-issued access token has only the bounded remaining lifetime. This is intentionally documented rather than claiming impossible immediate JWT revocation.

## Stable HTTPS reverse proxy

Keep SourceNerve bound to loopback:

```toml
[server]
bind = "127.0.0.1:7331"
```

Terminate public TLS at the reverse proxy and forward the stable hostname to `127.0.0.1:7331`. Do not expose port 7331 directly. Development ngrok tunnels are useful for testing but are not the final plugin submission hostname.

The reverse proxy must preserve normal MCP HTTP methods/streaming and must not replace OAuth `Authorization` headers with the operator bearer token.

## Verification

After deploying:

```bash
curl -fsS https://sourcenerve.example.com/healthz
curl -fsS https://sourcenerve.example.com/.well-known/oauth-protected-resource/mcp | jq
curl -i https://sourcenerve.example.com/mcp
```

The final command should return `401` and a `WWW-Authenticate` challenge containing the protected-resource metadata URL.

Test both positive and negative authorization paths:

- valid read token + granted workspace: read succeeds;
- token for another audience: `401`;
- expired token: `401`;
- token without `sourcenerve:read`: `403` at the MCP HTTP authorization boundary;
- subject without a workspace grant: workspace-scoped tool denied;
- read-only grant attempting mutation: tool denied;
- subject A targeting subject B's workspace: denied;
- OAuth configured with `allow_operator_bearer = false`: legacy operator token rejected on `/mcp` while `/api/v1` still accepts the operator bearer.

## Build and restart

This milestone changes Rust source and dependencies. After merging and pulling the commit, rebuild the release binary before restarting:

```bash
cd /home/khovan/Workplaces/SourceNerve
git switch main
git pull origin main
cargo build --release
./target/release/sourcenerve
```

Do not point production traffic at the old release binary after enabling OAuth configuration.