# SourceNerve Desktop bootstrap profile

Issue: #83

Architecture: `docs/desktop-architecture-adr.md`

UX: `docs/desktop-ux-spec.md`

## Purpose

The Desktop bootstrap profile is the versioned non-secret product contract consumed by the future Electron main process and release pipeline. It replaces normal-user TOML/environment setup without putting production credentials into the distributable application.

The canonical template is:

`desktop/bootstrap/product-profile.template.json`

The structural contract is:

`desktop/bootstrap/product-profile.schema.json`

CI safety checks live in:

`scripts/verify-desktop-bootstrap.sh`

## Runtime composition

Electron Main will materialize the managed runtime from:

```text
packaged product profile
        +
installation-generated identity/bearer
        +
OS secure-store Auth0/Git/Cloudflare installation credentials
        +
user-selected repositories/workspaces
        ↓
SourceNerve daemon + public routing runtime
```

The renderer never reads the raw secure-store values.

## Values committed in the profile

The profile intentionally contains only public/non-user-specific settings:

- product name/channel/legal/support URLs;
- loopback daemon bind and stable API/MCP paths;
- Auth0 issuer, audience/resource, OAuth scopes and callback URI;
- public MCP resource and protected-resource metadata URL;
- Bootstrap Broker endpoint paths;
- Cloudflare ownership mode flags;
- local-bearer entropy policy;
- workspace UX policy.

## Release placeholders

Two public deployment values are intentionally not invented in source:

- `__SOURCENERVE_AUTH0_NATIVE_CLIENT_ID__`
- `__SOURCENERVE_BOOTSTRAP_BROKER_URL__`

The Auth0 Native Application client ID is a public OAuth client identifier, but the actual application must first be created/configured in the Auth0 tenant. The Bootstrap Broker URL depends on #84 implementation/deployment.

Release packaging must materialize these placeholders before stable artifacts are published. A stable package must fail validation if an unresolved placeholder reaches the final packaged profile.

The template itself remains safe to commit and can be used by development tests before those external resources exist.

## Auth0 ownership

Desktop is treated as a native/public OAuth client using Authorization Code + PKCE.

The package may carry:

- issuer;
- Native App client ID;
- audience/resource;
- scopes;
- callback URI.

The package must not carry:

- Auth0 client secret;
- Management API token;
- end-user access/ID/refresh token;
- end-user password.

User tokens are created only after interactive login and are stored by Electron Main in OS secure storage.

## Local SourceNerve bearer

The profile contains only the policy:

`localBearerEntropyBits >= 256`

The value itself is generated on first launch for each installation. It is persisted in OS secure storage and passed only to the local daemon/main-process client boundary.

A release-wide static bearer is prohibited.

## Cloudflare ownership

The template currently selects `broker-managed` / `bootstrap-broker` mode to preserve the zero-touch installation contract while #84 owns the final enrollment/routing implementation.

The profile explicitly states that Desktop never receives a Cloudflare account-level API token.

If #84 selects installation-scoped tunnel routing, Desktop receives only an installation-scoped run credential after authenticated enrollment.

If #84 selects a central gateway architecture instead, the profile can migrate to `central-gateway` / `gateway-managed` through a new compatible profile version without exposing account credentials to Desktop.

## User-selected state

The following does not belong in the packaged profile:

- GitHub/GitLab user session;
- repository list;
- local clone/root path;
- workspace id/name/root/access;
- subject-to-workspace grants;
- SSH credentials;
- user-specific callbacks/webhooks/provider secrets.

These values are created only after login and UI selection.

## Validation policy

`scripts/verify-desktop-bootstrap.sh` validates the committed template without external dependencies beyond Python 3.

It asserts:

- loopback daemon binding;
- canonical MCP resource/metadata URLs;
- Auth0 PKCE mode and required scopes;
- Auth0 audience equals public MCP resource;
- at least 256 bits for generated local bearer;
- secure storage is required;
- Cloudflare account API token is never delivered to Desktop;
- expected release placeholders are bounded;
- provider/workspace selection remains user-owned;
- forbidden credential field names and common provider-token literals are absent.

Release CI later adds a second pass over the materialized packaged profile and renderer/source-map resources.

## Profile versioning

`schemaVersion` starts at `1`.

Rules:

1. Adding optional backward-compatible fields may remain in the same schema version when old Desktop builds can safely ignore them.
2. Changing required semantics, auth/routing ownership, or runtime fields that an old Desktop build cannot interpret requires a new schema version.
3. Desktop startup must reject a future unsupported schema instead of guessing.
4. Auto-update must migrate the Desktop/daemon/profile as one compatible release unit.
5. Product-profile migrations never overwrite user workspaces or Git/Auth0 sessions unless an explicit migration requires it.

## Downstream consumers

- #59 creates the Electron application/resources layout.
- #61 materializes this profile with OS secure-store state.
- #60 passes the resulting runtime into the Rust daemon.
- #62 renders profile/bootstrap state during onboarding.
- #65 consumes the Auth0 native-client settings.
- #66 consumes public-routing mode/status.
- #84 supplies the authenticated enrollment/routing contract.
- #76/#78 materialize and verify release profiles.
- #79 tests zero-config and secret-leakage behavior.

## Completion contract for #83

#83 establishes the product configuration ownership and versioned artifacts. It does not fabricate the external Auth0 Native Application or Bootstrap Broker deployment; those must be provisioned by their owning tasks before a stable packaged Desktop release.

The normal user contract remains unchanged:

`Auth0 sign-in -> Git login -> repository -> workspace -> Ready`
