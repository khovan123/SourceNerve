# SourceNerve Desktop security review

Issue: #75, extended by #63

Depends on: #58, #59, #60, #61, #81, #83

## Trust boundaries

```text
Untrusted repository / provider / MCP text
            |
            v
      React renderer
            |
            | fixed SourceNerveDesktopApi only
            v
         preload
            |
            | allowlisted + validated IPC
            v
       Electron Main
       /      |       \
secure store daemon  native picker / Git validation
            |
            v
      SourceNerve Rust
```

The renderer is treated as potentially compromised. It receives status, bounded sanitized logs and semantic results, but no bearer/token/credential read API, arbitrary shell/process primitive, arbitrary HTTP proxy, arbitrary filesystem API or environment access.

## Electron controls

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- `webSecurity: true`;
- `allowRunningInsecureContent: false`;
- `webviewTag: false`, with `will-attach-webview` denied as defense in depth;
- production DevTools disabled;
- permission requests/checks default-denied;
- `window.open` denied;
- navigation and redirects allowed only within the exact renderer document;
- development renderer URL is accepted only when it is loopback HTTP;
- packaged renderer is loaded only from the bundled local file;
- renderer source maps disabled.

The initial packaged/dev navigation uses the exact expected entry document as its pre-load baseline. After load, navigation continues to require that same document. This avoids both blocking the legitimate first load and treating unrelated `file:` URLs as same-origin.

## CSP

The renderer CSP denies base URI changes, objects, frames, form submissions, workers and media. Scripts are self-only and `unsafe-eval` is prohibited. Development HMR can connect only to loopback WebSocket origins; the broad `ws:` scheme is explicitly prohibited by the security verifier.

`style-src 'unsafe-inline'` is currently retained only for Vite development/style injection. It grants no script execution and can be revisited if the renderer build is moved to nonce/hash-only style delivery.

## IPC boundary

Inbound IPC has one allowlist derived from the semantic Desktop API. Every invocation is checked for:

1. the exact main BrowserWindow/webContents;
2. the main frame rather than a subframe;
3. the currently trusted renderer document;
4. an allowlisted inbound channel;
5. the exact argument shape for that operation.

No-argument operations reject extra payloads. Cancellation accepts exactly one bounded operation identifier. `desktop:runtime-event` is outbound-only.

Daemon lifecycle IPC is intentionally semantic (`start`, `stop`, `restart`, `attach external`). A compromised renderer can request those product operations but cannot choose an executable, command, argument, PID target, signal, working directory, environment or secret; Electron Main and the SourceNerve server remain authoritative.

Workspace IPC is also semantic. A renderer can request `pick repository`, `save workspace`, `remove workspace`, or `index workspace`; it cannot supply a repository root/path in the save payload, invoke arbitrary Git commands, choose arbitrary SourceNerve HTTP paths, or request filesystem deletion.

## Native workspace picker and path boundary

#63 introduces one native directory picker, but does not introduce arbitrary filesystem IPC.

The renderer calls a no-argument `pickWorkspaceRepository()`. Electron Main opens `dialog.showOpenDialog({ properties: ["openDirectory"] })`, canonicalizes the selected path, proves it is the exact Git top-level root, then stores the canonical root behind a random short-lived `selectionId`.

`WorkspaceSaveInput` deliberately has no `root` field. Runtime IPC validation rejects unknown fields, so a compromised renderer cannot construct a save request for `/etc`, `$HOME`, a sibling checkout, or a symlink-swapped path. The selection is revalidated immediately before mutation.

Only a user-selected local root is displayed back to the local renderer. It is never sent to provider/bootstrap/public-MCP services by this feature. Git remote URLs remain Main-only because they can contain embedded credentials; renderer receives only the remote **name** plus derived GitHub/GitLab repository slug.

Moved, deleted, or corrupted registered repositories are represented as an individual invalid workspace. The list operation does not turn one broken local checkout into a failure of the entire workspace screen.

No `shell.openPath`, raw file reader, arbitrary delete, or generic path IPC is added.

## Workspace removal boundary

`Remove workspace` means SourceNerve registration and repository-derived state only.

- managed registry metadata is removed;
- generated runtime config is rematerialized;
- the managed daemon is restarted/stopped as required;
- at daemon registration, stale SQLite workspace rows are pruned transactionally and FK cascades remove SourceNerve-owned index/graph/memory state;
- repository directories/files are never a deletion target.

An external/conflicting daemon blocks managed workspace configuration changes. Desktop never claims to reconfigure a process it does not own.

## Deep-link / OAuth callback boundary

The reserved Desktop callback parser accepts only:

```text
sourcenerve://oauth/callback
```

It rejects unexpected host/path/port/userinfo/fragment/query keys and duplicate query keys. State is required and bounded. The callback must contain exactly one of a bounded authorization code or bounded OAuth error. The current #75 handler never logs or exposes the authorization code/state; #65 will consume the parsed callback through its dedicated Auth0 state machine.

## External URLs

`window.open` is denied. The security policy contains an explicit HTTPS-origin allowlist helper for future user-intent links; future features must use it rather than exposing `shell.openExternal(url)` generically.

## Child process and secret boundary

#60 constructs the daemon environment from a narrow parent allowlist plus trusted Desktop runtime values. The renderer cannot access `process.env`. The local bearer, Auth0 material, provider credentials and Cloudflare credentials remain in Electron Main / OS secure storage / managed child boundaries.

#63 runs only a fixed set of non-interactive `git -C <trusted-root> ...` inspection commands from Main. The renderer cannot choose the executable or raw argument vector. `GIT_TERMINAL_PROMPT=0` prevents credential prompts. Git status is reduced to a dirty boolean, and remote URLs are used only for provider metadata derivation.

Daemon logs are sanitized and bounded before renderer events, including known secrets, bearer/query tokens, config path and local user-home paths.

## Dependency audit policy

Runtime dependencies and build tooling have different exposure and are gated separately rather than hiding all findings behind one blanket exception.

### Runtime gate

```text
npm audit --omit=dev --audit-level=high
```

This gate has **no exceptions**. Any high/critical vulnerability that can ship as an application runtime dependency fails CI.

### Build-tool gate

The full dependency tree is still audited. `verify-dependency-audit.mjs` permits only exact high/critical GitHub advisory IDs that were reviewed as belonging to the current stable Electron Forge 7.11.2 packaging toolchain. Any new severe advisory ID fails CI automatically.

At the time of this review, stable Forge 7.11.2 declares `@electron/packager ^18.3.5` and `@electron/rebuild ^3.7.0`. Their fixed current releases moved to new majors (`@electron/packager` 20 and `@electron/rebuild` 4), so forcing those majors underneath Forge 7 would bypass Forge's declared compatibility range. We do not use `npm audit fix --force`, because npm proposes an older Forge downgrade rather than a reviewed security migration.

The reviewed build-only advisory list is temporary technical debt, not a general package allowlist. It is keyed by exact GHSA IDs and must be reduced when a stable Forge release adopts the corrected Packager/Rebuild dependency line. The application package job remains mandatory, so compatibility regressions in Forge/tooling cannot pass only on dependency metadata.

The `fdir -> picomatch` tree is separately overridden to a compatible v4 line because npm previously deduped an incompatible v2 instance into `fdir@6.5.0`. `npm ls --all` is a CI gate so invalid dependency trees fail before packaging.

## Threat mapping

| Threat | Control |
|---|---|
| Malicious repository/MCP text becomes HTML/script | React escaping + self-only script CSP + no Node integration |
| Renderer XSS reads secrets | context isolation, typed preload only, no secret getters/environment/filesystem |
| Renderer invokes arbitrary process | fixed daemon lifecycle operations; no command/args/PID/signal IPC |
| Renderer registers arbitrary filesystem path | native picker + opaque selection ID + exact Git-root revalidation; save payload has no path |
| Renderer injects raw Git command/remote URL | fixed Main-owned Git commands; raw remote URL never crosses IPC |
| Workspace remove deletes repository | removal targets managed registry/runtime/SQLite state only; no repository delete primitive exists |
| Crafted IPC payload | trusted sender/main-frame check + channel allowlist + exact argument validation |
| Crafted Auth0/deep link | exact callback scheme/host/path + bounded fields + state requirement |
| Navigation to remote renderer | exact-document navigation/redirect policy + loopback-only dev server |
| New window/webview escape | `window.open` and webview attach denied |
| Browser permission abuse | permission request/check default-denied |
| Remote WebSocket exfiltration | CSP removes broad `ws:` and limits HMR to loopback |
| Secret/path leakage in daemon logs | redaction before renderer event/truncation |
| Renderer/source-map extraction | production DevTools off + renderer/main/preload source maps disabled |
| Runtime dependency vulnerability | zero-exception `npm audit --omit=dev --audit-level=high` |
| New build-tool severe advisory | exact reviewed GHSA allowlist; unknown high/critical advisory fails CI |
| Broken npm dedupe/peer tree | `npm ls --all` plus scoped compatibility override |

## Automated gates

- `security-policy.test.ts`: renderer navigation, external HTTPS allowlist and OAuth callback parser;
- `ipc-policy.test.ts`: channel/argument allowlist, outbound-only events, workspace path injection rejection;
- `workspace-manager.test.ts`: exact Git root, provider derivation, branch and repository inspection;
- `workspace-store.test.ts`: bounded schema and duplicate/metadata validation;
- daemon-manager tests: child environment and log redaction;
- Rust DB test: configured workspaces prune removed registration/state;
- `scripts/verify-security-baseline.mjs`: static fail-closed Electron/CSP/source-map/renderer primitive checks;
- runtime dependency audit with no severe exceptions;
- full build-tool audit against the exact reviewed severe-advisory set;
- full dependency-tree validation;
- normal Desktop typecheck/tests/package verification;
- existing Rust and production smoke workflows remain authoritative for server-side path/auth/mutation guards.

## Follow-up rule

Every future Desktop IPC channel must be added to the typed API and inbound policy deliberately, with bounded runtime validation and tests. Features must not weaken server-side SourceNerve guards or move credentials into renderer state for convenience.