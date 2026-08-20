# SourceNerve Desktop bootstrap profile

Architecture: `docs/desktop-architecture-adr.md`

UX: `docs/desktop-ux-spec.md`

## Purpose

The Desktop bootstrap profile is the versioned non-secret product contract consumed by Electron Main and the release pipeline. Normal Desktop users do not configure SourceNerve with TOML, shell exports, Auth0 identifiers, or provider OAuth client IDs.

Canonical artifacts:

- `desktop/bootstrap/product-profile.template.json`
- `desktop/bootstrap/product-profile.schema.json`
- `scripts/verify-desktop-bootstrap.sh`

## Runtime composition

Desktop starts from a small packaged static profile:

```text
packaged product profile
        |
        | contains bootstrap backend URL
        v
GET /v1/desktop/client-config
        |
        | issuer + audience/resource + Auth0 Native client ID
        v
validated in-memory product profile
        +
installation-generated identity/local bearer
        +
gh / glab CLI-managed provider authentication
        +
user-selected repositories/workspaces
        v
SourceNerve local daemon + Public MCP runtime
```

The renderer never reads raw Auth0 sessions, provider tokens, Cloudflare credentials, or the local bearer.

## Static values committed in the profile

The profile contains public product policy and bootstrap structure:

- product name/channel/legal/support URLs;
- loopback daemon bind and stable API/MCP paths;
- Auth0 scopes, callback URI, and PKCE flow policy;
- `gh` / `glab` provider ownership and API origins;
- Bootstrap Broker URL placeholder and endpoint paths;
- Cloudflare ownership mode flags;
- local-bearer entropy policy;
- workspace UX policy.

The deployment-specific Auth0 values and canonical Public MCP resource are deliberately **not** committed into the Desktop profile.

## Server-managed values

The template carries `server-managed` markers for:

- Auth0 issuer;
- Auth0 Native Application client ID;
- Auth0 audience/resource;
- Public MCP resource;
- protected-resource metadata URL.

Before Auth0 initialization, Electron Main calls:

```text
GET <bootstrapBroker.baseUrl>/v1/desktop/client-config
```

The control plane reads the real values from its repository-root `.env`, returns the public client configuration, and Desktop validates it before continuing.

This means changing the Auth0 issuer/audience/Native Application client ID is a backend deployment change, not a Desktop rebuild requirement.

## Build-time bootstrap value

Desktop must know one location before it can ask the backend for configuration. Therefore the only product-profile deployment placeholder is:

```text
__SOURCENERVE_BOOTSTRAP_BROKER_URL__
```

Local development/package materialization reads it from `desktop/.env`:

```dotenv
SOURCENERVE_BOOTSTRAP_BROKER_URL=https://sourcenerve.fogewise.io.vn
```

`desktop/scripts/materialize-product-profile.mjs` reads that file directly and rejects shell `export KEY=VALUE` syntax. Auth0 issuer/audience/client ID do not belong in `desktop/.env`.

## Backend `.env` ownership

The control plane owns the corresponding deployment values:

```dotenv
SOURCENERVE_OAUTH_ISSUER=https://YOUR_AUTH0_TENANT/
SOURCENERVE_OAUTH_RESOURCE=https://YOUR_PUBLIC_DOMAIN/mcp
SOURCENERVE_AUTH0_NATIVE_CLIENT_ID=replace-with-auth0-native-application-client-id
```

The Native Application client ID is public OAuth metadata, not a secret, but it is centrally managed so Desktop packages do not drift from the deployed Auth0 configuration.

No Auth0 client secret or Management API token is sent to Desktop.

## Git provider authentication

SourceNerve does not ship GitHub/GitLab OAuth client IDs or Device Flow implementations.

- GitHub authentication is owned by `gh` CLI.
- GitLab authentication is owned by `glab` CLI.
- Desktop detects authenticated CLI sessions and performs repository discovery/validation through the CLI.
- Provider tokens requested transiently for the local Rust daemon are never written into the product profile or generated TOML.

## Local SourceNerve bearer

The profile contains only the policy `localBearerEntropyBits >= 256`. The bearer value itself is generated per installation, stored outside the renderer, and passed only across the trusted Electron Main/local-daemon boundary.

A release-wide static bearer is prohibited.

## Cloudflare ownership

Desktop never receives a Cloudflare account-level API token. The control-plane Bootstrap Broker owns account-level Cloudflare provisioning and returns only installation-scoped runtime material after authenticated enrollment.

## Validation policy

`scripts/verify-desktop-bootstrap.sh` asserts that:

- the daemon remains loopback-bound;
- Auth0 uses Authorization Code + PKCE and required scopes;
- issuer/audience/Native client ID/Public MCP URLs are `server-managed` in the committed Desktop template;
- the only allowed build placeholder is the Bootstrap Broker URL;
- GitHub/GitLab OAuth fields are absent;
- GitHub uses `gh` and GitLab uses `glab`;
- secure storage/local-bearer policy remains intact;
- Cloudflare account API credentials are never delivered to Desktop;
- forbidden credential fields/token-like literals are absent.

After backend hydration, runtime validation requires actual credential-free HTTPS Auth0/Public MCP values and requires the Auth0 audience to equal the Public MCP resource.

## User contract

The normal flow is:

```text
Desktop starts
-> fetch public client config from backend
-> Auth0 sign-in
-> detect gh/glab login
-> repository
-> workspace
-> Ready
```
