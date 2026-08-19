# SourceNerve Desktop managed runtime and secure storage

Issue: #61

Depends on: #58, #59, #83, #84

## Goal

Normal Desktop users do not edit `sourcenerve.toml`, export secrets, or copy bearer/provider/tunnel tokens. Electron Main owns the runtime profile and secret materialization while the Rust daemon keeps the existing SourceNerve configuration contract.

## Configuration layers

The managed runtime combines four layers:

```text
bundled product profile (#83)
        +
installation identity + local bearer
        +
OS secure-store Auth0/Git/Cloudflare credentials
        +
user-selected workspace/repository state
        ↓
generated daemon config + child-process environment
```

The generated TOML contains only non-secret product/workspace configuration. Secrets are passed to the daemon/process boundary through environment variables owned by Electron Main.

## Product profile

`desktop/src/main/runtime-profile.ts` reads the versioned profile from:

`desktop/bootstrap/product-profile.template.json`

Development builds may use the two explicit #83 placeholders. Packaged builds fail closed when `auth0.nativeClientId` or `bootstrapBroker.baseUrl` is unresolved.

The loader revalidates the critical runtime contract even though the source template also has a JSON Schema:

- schema version 1;
- SourceNerve product identity;
- loopback daemon bind `127.0.0.1:7331`;
- `/healthz` and `/mcp` paths;
- Auth0 Authorization Code + PKCE;
- canonical issuer/audience relationship;
- SourceNerve callback protocol;
- at least 256-bit local-bearer policy;
- required secure storage;
- no Cloudflare account API token delivered to Desktop.

## Per-install identity

Electron Main creates `installation.json` under the managed Desktop data directory.

The installation ID is opaque, persistent, and non-secret. It is used by #84 to identify the installation routing assignment.

The local SourceNerve bearer is different:

- generated with Node's cryptographic `randomBytes(32)`;
- 256 bits before base64url encoding;
- stored only in OS-backed encrypted storage;
- never written into generated TOML;
- injected into the daemon as `SOURCENERVE_BEARER_TOKEN`;
- independently rotatable without changing the installation ID.

No release-wide bearer exists.

## OS-backed secret storage

The encrypted store is implemented by:

- `desktop/src/main/secure-store.ts` — persistence abstraction;
- `desktop/src/main/electron-safe-storage.ts` — Electron OS encryption adapter.

Supported platform ownership:

- macOS: Keychain through Electron safeStorage;
- Windows: DPAPI-backed Electron safeStorage;
- Linux/Fedora: Secret Service/KWallet-backed Electron safeStorage.

Linux fails closed when Electron reports the `basic_text` backend. SourceNerve Desktop does not silently downgrade a production secret store to plaintext-equivalent storage.

The encrypted persistence file is also created with restrictive filesystem permissions where the platform honors POSIX modes. This is defense in depth; OS-backed encryption remains the required secret boundary.

## Secret keys

The store reserves typed entries for:

- `localBearer`;
- `auth0AccessToken`;
- `auth0RefreshToken`;
- `githubToken`;
- `gitlabToken`;
- `cloudflareTunnelToken`.

Renderer never gets a generic secret-read IPC. Main may later expose only presence/state through #81.

## Generated SourceNerve TOML

The generated Desktop TOML contains:

- server bind;
- state directory;
- OAuth issuer/resource and grants;
- workspace definitions;
- Git provider/repository metadata.

It intentionally contains no local bearer and no GitHub token.

The Rust `AuthConfig.bearer_token` field now has a serde default so managed TOML may contain an empty `[auth]` table. `Config::load` still enforces the same minimum bearer length after applying `SOURCENERVE_BEARER_TOKEN`; therefore headless users who omit both TOML and environment bearer still fail validation.

This keeps the existing headless config contract while allowing Desktop to avoid persisting the local bearer in readable TOML.

## Child-process environment

`materializeRuntime()` prepares a bounded environment fragment for the future #60 lifecycle manager:

```text
SOURCENERVE_CONFIG=<managed TOML path>
SOURCENERVE_BEARER_TOKEN=<secure-store local bearer>
SOURCENERVE_OAUTH_ISSUER=<product issuer>
SOURCENERVE_OAUTH_RESOURCE=<product audience>
SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER=false
SOURCENERVE_GITHUB_TOKEN=<secure-store token, only when connected>
```

#60 must construct the complete child environment explicitly rather than spreading the parent shell environment blindly.

## Workspace state

Workspace entries remain user-owned configuration and are not packaged into the application. #63 owns repository selection/validation and persists the workspace records consumed here.

The materializer validates:

- unique bounded workspace IDs;
- non-empty names;
- absolute local roots;
- bounded remote/default branch;
- provider/repository consistency;
- OAuth grants reference existing workspaces;
- duplicate subject/workspace grants are rejected.

## Renderer boundary

The scaffold exposes only safe bootstrap diagnostics in `RuntimeInfo`:

- ready/not ready;
- product-profile schema version;
- selected OS secure-storage backend;
- safe error text.

It does not expose:

- installation local bearer;
- Auth0 access/refresh tokens;
- Git provider tokens;
- Cloudflare tunnel token;
- encrypted payload bytes.

#81 replaces the scaffold runtime call with the full semantic typed Desktop API while preserving this boundary.

## Recovery

Local-bearer rotation is an explicit trusted-main operation. #60/#74 must stop/restart the daemon atomically when exposing this recovery action so Desktop and daemon never temporarily disagree on the bearer.

Deleting/revoking Auth0, Git or Cloudflare credentials remains independently owned by their connection/lifecycle issues. Resetting one credential must not erase unrelated workspace state.

## Tests

Desktop unit tests cover:

- encrypted persistence does not contain plaintext secret values;
- presence APIs expose booleans rather than secret values;
- installation ID and bearer persist across restart;
- bearer rotation preserves installation identity;
- generated TOML excludes local bearer and GitHub token;
- generated process environment contains the expected trusted-main secrets;
- unresolved release placeholders fail packaged-profile validation;
- workspace/provider inconsistencies fail before daemon startup.

The existing Rust CI remains authoritative for the SourceNerve daemon configuration/runtime behavior. #60 adds the real bundled-daemon startup/readiness integration gate using this materialized profile.
