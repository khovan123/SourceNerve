# ADR: SourceNerve Desktop architecture, process model, and security boundary

Status: Accepted for Desktop implementation

Decision issue: #58

Related issues: #57, #59, #60, #61, #62, #64, #65, #66, #75, #80, #81, #83, #84

## Context

SourceNerve is currently a Rust service configured primarily through `sourcenerve.toml` and environment variables. The existing core owns workspace validation, repository intelligence, graph/index state, OAuth grants, Git/provider operations, guarded mutation workflows, and MCP/HTTP surfaces. The Desktop project must make this product usable on Fedora, macOS, and Windows without moving that business logic into the GUI.

The Desktop product contract is zero-terminal setup for normal users:

`Auth0 sign-in -> Git provider login -> repository -> workspace -> Ready`

Normal users do not configure bearer tokens, Cloudflare credentials, OAuth issuer/resource/scopes, public MCP routes, or raw TOML/environment variables.

## Decision

SourceNerve Desktop will use an Electron Forge + TypeScript + React + Vite application under `desktop/`, while the existing Rust SourceNerve binary remains the authoritative backend/daemon.

The desktop runtime is split into four trust zones:

1. **Renderer** — untrusted presentation layer. React UI only.
2. **Preload** — narrow typed bridge. Exposes an allowlisted semantic API only.
3. **Electron Main** — trusted desktop control plane. Owns native integration, secure storage, auth orchestration, daemon/tunnel lifecycle, and the authenticated local API client.
4. **Rust SourceNerve daemon** — authoritative repository/business logic and MCP/API server.

A fifth server-side trust zone is introduced by #84:

5. **Bootstrap Broker** — server-side enrollment service that holds account-level Cloudflare credentials and provisions per-install public routing after Auth0 authentication.

## Process model

```text
+------------------------------+
| Electron Renderer            |
| React/Vite UI                |
| no Node, no raw secrets      |
+--------------+---------------+
               |
               | typed preload API
               v
+------------------------------+
| Electron Main                |
| - Auth0 PKCE/session         |
| - Git provider login         |
| - OS secure storage          |
| - config materialization     |
| - daemon lifecycle           |
| - cloudflared lifecycle      |
| - native file dialogs        |
| - typed local API client     |
+---------+----------+---------+
          |          |
          | loopback | supervised child
          v          v
+----------------+  +------------------+
| SourceNerve    |  | cloudflared      |
| Rust daemon    |  | per-install route|
| 127.0.0.1:7331 |  +---------+--------+
+-------+--------+            |
        |                     | TLS tunnel
        |                     v
        |               Public MCP route
        |
        +--> repository / SQLite / Git
```

The SourceNerve daemon remains loopback-bound by default. Public access is provided through the managed Cloudflare tunnel rather than by exposing the daemon socket directly.

## Identity model

### SourceNerve identity

Desktop and ChatGPT Plugin use the same Auth0 account population. The operator creates/controls end-user accounts in Auth0.

Desktop is a native/public OAuth client and uses Authorization Code + PKCE. The distributable application may contain only non-secret Auth0 product values such as issuer, Native App client ID, resource/audience, scopes, and callback/deep-link scheme.

Auth0 access/ID/refresh tokens are created only after interactive login and are persisted by Electron Main in OS secure storage.

Auth0 `sub` is the stable SourceNerve identity used by workspace authorization policy.

### Git provider identity

GitHub/GitLab login is separate from SourceNerve/Auth0 identity. Git provider credentials authorize repository/provider operations and do not define SourceNerve workspace identity.

A user may re-authenticate Git without losing their SourceNerve session, and may re-authenticate SourceNerve without deleting Git/workspace configuration.

## Secret ownership

### Bundled product profile: safe to distribute

The package may include:

- SourceNerve bind/port defaults;
- Auth0 issuer, native client ID, resource/audience, scopes, callback scheme;
- MCP resource/product URLs and hostname pattern;
- Bootstrap Broker base URL and non-secret enrollment metadata;
- Cloudflare mode, but no account/tunnel credential;
- plugin/legal/support URLs and product metadata;
- daemon/config/state path defaults;
- bootstrap profile schema/version.

### Generated per installation

Electron Main generates and persists:

- opaque installation ID;
- local SourceNerve bearer with at least 256 bits of cryptographic entropy;
- installation key material if #84 requires it;
- derived runtime configuration.

The local bearer is shared only between Electron Main's authenticated local client and the local Rust daemon. It is never shown to the normal user and is never release-wide.

### Obtained after interactive login

Electron Main stores in OS secure storage:

- Auth0 access/refresh/session material;
- GitHub/GitLab provider session/token material.

### Provisioned server-side

After Auth0 login, Electron Main calls the #84 Bootstrap Broker. The broker keeps the Cloudflare account-level API credential server-side and returns only an installation-scoped tunnel/run credential and routing assignment. The installation credential is stored in OS secure storage and passed only to the managed `cloudflared` process.

### Forbidden in desktop artifacts

The following must never be embedded in public desktop binaries, renderer assets, preload globals, source maps, or tracked product config:

- Auth0 Management API token or client secret;
- Auth0 end-user tokens/passwords;
- Cloudflare account-level API token;
- a static Cloudflare tunnel credential shared by all installations;
- a static SourceNerve bearer shared by all installations;
- GitHub/GitLab user tokens;
- SSH private keys;
- user repository/workspace paths;
- subject-to-workspace grant assignments;
- deployment/user-specific webhook/callback secrets.

## OS secure storage

Electron Main owns secure storage access.

- macOS: Keychain.
- Windows: Credential Manager / DPAPI-backed implementation.
- Linux/Fedora: Secret Service/libsecret where available, with a separately reviewed fallback before stable release.

The renderer receives only semantic state such as `configured`, `expired`, `missing`, `revoked`, or `ready`. No IPC method returns raw secret values.

## Renderer security boundary

Renderer configuration:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- sandbox enabled where compatible;
- strict CSP;
- no remote renderer content.

The renderer is explicitly forbidden from:

- reading environment variables;
- reading arbitrary filesystem paths;
- spawning child processes or shell commands;
- constructing authenticated requests to the local daemon;
- reading Auth0/Git/Cloudflare/local bearer secrets;
- writing runtime TOML or environment configuration directly;
- controlling `cloudflared` or the Rust daemon through generic process APIs;
- opening arbitrary external URLs or paths supplied by repository/tool content;
- bypassing SourceNerve server-side workspace/mutation/provider guards.

All privileged operations are semantic allowlisted IPC commands implemented by #81/#75.

## IPC and local API model

There will be no generic `invoke(command, args)`, generic shell, generic filesystem proxy, or generic HTTP proxy exposed to renderer.

Preload exposes versioned semantic operations such as:

- auth state / sign-in / sign-out;
- Git provider connection state;
- workspace list/add/update/remove;
- daemon start/stop/restart/status;
- public MCP/tunnel status and repair;
- repository search/intelligence operations;
- guarded task/provider lifecycle actions;
- bounded sanitized log/event subscriptions.

Electron Main owns the authenticated SourceNerve client and injects the local bearer itself.

## Configuration materialization and precedence

Desktop-managed mode derives runtime state from four layers, highest precedence last:

1. packaged non-secret product profile;
2. installation-generated settings and secure-store records;
3. Auth0/Git session state;
4. user-selected workspace/repository configuration.

Electron Main materializes a daemon-compatible runtime configuration and child-process environment. Secrets should be supplied through process/environment/control boundaries instead of user-readable TOML where possible.

The Desktop profile is versioned independently so updates can migrate product defaults without silently overwriting user workspaces/provider sessions.

## Compatibility with existing headless mode

Existing CLI/headless behavior remains supported.

The current Rust loader continues to support `sourcenerve.toml` and documented environment overrides. Desktop-managed mode does not remove those interfaces; it generates/materializes values for the same Rust configuration contract.

Migration issue #73 may import user-specific workspace/provider/state data from existing configuration, but product-level OAuth/Cloudflare/bearer settings are re-provisioned by the Desktop model instead of copied blindly.

No SourceNerve business logic is duplicated in TypeScript.

## Workspace ownership and authorization

Workspace definitions remain user-selected data: repository, local root/clone target, workspace id/name, access mode, remote/default branch, provider and repository slug.

The Desktop learns the current Auth0 `sub` automatically after login. It never asks the user to copy a subject into TOML.

The policy for automatically granting the current user access to a newly created local workspace must be finalized in #65/#84. The UI may request an allowed access mode, but it cannot self-escalate beyond server policy.

## Cloudflare/public MCP ownership

A public release must not use a single shared tunnel token/hostname as the routing identity for all desktop installations.

#84 must provide one of these reviewed routing models before public Desktop rollout:

1. unique installation tunnel/hostname assignment, preferred for the local-daemon architecture; or
2. a central SourceNerve gateway that deterministically routes authenticated requests to the correct connected desktop agent.

Electron Main supervises `cloudflared` only after enrollment and only with installation-scoped credentials. Revoke/rotate/re-enroll operations go through the Bootstrap Broker.

## Port and single-instance ownership

Electron Main owns the managed daemon lifecycle and uses a single-instance application lock.

Default daemon bind is loopback on the product-configured port. Startup checks whether the port is free and whether an existing SourceNerve instance is compatible. The app must never kill an unrelated process blindly.

When another compatible SourceNerve process already owns the port, the product must present an explicit attach/restart/recovery path according to #60.

## Shutdown ordering

Managed shutdown order is:

1. stop accepting new Desktop operations;
2. stop/release public tunnel process;
3. request graceful SourceNerve daemon shutdown;
4. flush Desktop state/log metadata;
5. exit Electron Main.

Unexpected daemon/tunnel exits are reported as state changes and use bounded recovery/backoff, not uncontrolled restart loops.

## Upgrade and migration ownership

- Desktop package owns Desktop, bundled daemon, and bootstrap profile compatibility as one release unit.
- Rust daemon owns repository/index/state schema validity.
- Electron Main owns secure-store and Desktop config migrations.
- #84 broker owns enrollment/tunnel credential lifecycle and server-side cleanup.
- Updater must not replace user workspace/provider state with release defaults.

## Threat model summary

### Renderer compromise / XSS

Risk: repository/tool content reaches React and executes malicious script.

Controls: no Node integration, context isolation, CSP, narrow IPC, no raw-secret retrieval, validated external navigation.

### Packaged binary extraction

Risk: users can inspect ASAR/resources/source maps.

Controls: no account-level Auth0/Cloudflare credentials or static bearer in distributable resources; release secret scanning.

### Malicious repository/path input

Risk: path traversal, arbitrary file access, command injection.

Controls: native picker and validated IPC boundaries; existing SourceNerve canonical-path/mutation guards stay authoritative; no generic shell.

### Local daemon impersonation / port collision

Risk: another process owns the expected port.

Controls: lifecycle/version/readiness checks and explicit conflict handling; local bearer remains installation-scoped.

### Token leakage through logs/support

Risk: child-process output or error objects expose credentials.

Controls: structured redaction before renderer/log/support-bundle publication and tests for known credential patterns.

### Cross-install MCP routing

Risk: Plugin request for installation A reaches installation B.

Controls: #84 per-install routing identity or explicitly reviewed deterministic gateway; no shared tunnel identity boundary.

### Auth0/Git identity confusion

Risk: repository provider identity is accidentally treated as SourceNerve authorization identity.

Controls: separate session models; Auth0 `sub` remains SourceNerve identity; provider account only supplies repository/provider capability.

## Consequences

### Positive

- Normal users can reach Ready without terminal configuration.
- Existing Rust security/business logic remains authoritative.
- Renderer compromise does not directly reveal provider/infrastructure secrets.
- Auth0, Git, workspace, daemon, and Cloudflare states can be diagnosed independently.
- The same architecture supports Fedora, Windows, and macOS packaging.

### Costs

- Electron Main becomes a meaningful trusted control plane and requires dedicated IPC/security tests.
- Public Desktop distribution requires a server-side Bootstrap Broker or gateway rather than shipping a Cloudflare account credential.
- Secure storage and deep-link behavior require platform-specific testing.
- Desktop and Rust daemon versions must be released with an explicit compatibility contract.

## Implementation gates created by this ADR

Before feature implementation proceeds:

- #80 must freeze the UI information architecture against these trust boundaries.
- #83 must define the concrete versioned product bootstrap profile.
- #84 must define the enrollment API and routing model.

Foundation implementation then proceeds through #59, #81, #61, #60, and #75 before higher-level Desktop features rely on the control plane.
