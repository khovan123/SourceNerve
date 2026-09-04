# SourceNerve Desktop UX information architecture and interaction spec

Status: Accepted for Desktop implementation

Decision issue: #80

Architecture dependency: `docs/desktop-architecture-adr.md` / #58

Related issues: #57, #59, #60, #61, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #79, #81, #83, #84

## Product experience goal

SourceNerve Desktop should feel like a native developer application, not a wrapper around terminal setup.

The happy path is deliberately short:

```text
Welcome
  -> Sign in to SourceNerve
  -> Connect GitHub/GitLab
  -> Choose repository
  -> Create/select workspace
  -> Start runtime
  -> Ready
```

Normal users must not need to understand or edit Cloudflare, bearer tokens, OAuth issuer/resource/scopes, MCP product routing, daemon environment variables, or TOML.

Infrastructure remains visible as health/status when useful, but not as a setup burden.

## UX principles

1. **Identity before infrastructure** — users see SourceNerve account and Git provider identity, not token fields.
2. **Repository first** — workspace and repository state are central; runtime plumbing stays secondary.
3. **Status over configuration** — daemon/public-MCP failures appear as health cards with retry/repair actions.
4. **Explicit mutation** — branch/patch/commit/push/PR/merge are visually separated and confirmed.
5. **Read-only is obvious** — read-only workspaces visibly suppress mutation controls.
6. **No hidden destructive shortcuts** — no force push/reset/raw shell/default-branch direct commit UI.
7. **Progress is durable** — runtime setup and task workflows survive app restart and can resume.
8. **Secrets are never a UI artifact** — renderer shows configured/missing/expired/revoked state only.

## Primary navigation

Persistent left navigation:

```text
SourceNerve
├── Overview
├── Workspaces
├── Tasks & Changes
├── Pull Requests
├── Connections
├── Logs & Diagnostics
└── Settings
```

The active workspace selector is persistent in the app shell where a screen is workspace-scoped.

### Overview

Purpose: one operational summary for account, provider, daemon, public MCP, and workspace readiness.

### Workspaces

Purpose: add/select repositories and configure SourceNerve workspace metadata without editing TOML.

### Plugins / MCP intelligence

Purpose: manage workspace-visible plugin skills and MCP extensions that provide specialized repository intelligence outside the SourceNerve core.

### Tasks & Changes

Purpose: durable guarded branch/patch/review/commit/push workflows.

### Pull Requests

Purpose: provider issue/PR/MR state and guarded merge operations.

### Connections

Purpose: SourceNerve/Auth0, GitHub/GitLab, ChatGPT Plugin, and public MCP status.

### Logs & Diagnostics

Purpose: live sanitized logs, readiness detail, repair actions, support bundle.

### Settings

Purpose: user-facing desktop behavior, update preferences, appearance, background mode, and advanced read-only diagnostics.

## App shell

Desktop frame:

```text
+--------------------------------------------------------------------------------+
| SourceNerve | Workspace: my-api v | Search/Command | Account avatar | status   |
+--------------+-----------------------------------------------------------------+
| Overview     |                                                                 |
| Workspaces   |                       Current screen                             |
| Intelligence|                                                                 |
| Tasks        |                                                                 |
| Pull Requests|                                                                |
| Connections  |                                                                 |
| Diagnostics  |                                                                 |
| Settings     |                                                                 |
+--------------+-----------------------------------------------------------------+
| Daemon: Ready | Public MCP: Ready | GitHub: Connected | Index: Current         |
+--------------------------------------------------------------------------------+
```

The bottom status strip is compact and clickable. It never displays secret values.

## First-run onboarding wireflow

### Step 1 — Welcome

Content:

- SourceNerve product value in one sentence.
- supported platforms/build version;
- primary CTA: `Get started`;
- secondary CTA: `Import existing SourceNerve setup` for #73.

No infrastructure prerequisites list is shown to normal users.

### Step 2 — SourceNerve account

Screen title: `Sign in to SourceNerve`

Content:

- explanation that the user signs in with the account provided by the SourceNerve operator;
- primary CTA: `Sign in`;
- browser handoff status;
- callback progress;
- account avatar/name/email after success.

Failure states:

- login cancelled;
- account disabled/revoked;
- callback invalid/expired;
- product OAuth discovery/config mismatch;
- secure-store unavailable.

No access/refresh token field is ever shown.

### Step 3 — Secure bootstrap

This is primarily a progress screen, not a form.

Checks:

```text
[✓] Product profile loaded
[✓] Local installation identity created
[✓] Local SourceNerve bearer prepared
[✓] SourceNerve account verified
[✓] Public routing enrollment complete
[✓] Cloudflare runtime ready
```

If a layer fails, show one named error with `Retry` and `View diagnostics`.

Do not expose raw bearer/Cloudflare/Auth0 values.

### Step 4 — Connect Git provider

Cards:

```text
GitHub
[ Connect GitHub ]

GitLab
[ Connect GitLab ]
```

After login display:

- account name/avatar;
- provider hostname;
- repository discovery capability;
- push capability status separately from provider API status.

Advanced PAT entry, if ever required by provider limitation, is behind an explicitly labelled advanced fallback and is not part of the standard onboarding.

### Step 5 — Choose repository

Two choices:

1. `Choose from GitHub/GitLab`
2. `Use existing local repository`

Provider list fields:

- owner/group;
- repository name;
- visibility;
- clone/local status;
- default branch;
- read/write capability.

Local picker validates that the selected directory is a Git repository and derives remote/provider/repository slug when possible.

### Step 6 — Workspace

Fields:

- Workspace name;
- Workspace ID, automatically generated from name with editable safe value;
- Repository;
- Local path/clone destination;
- Access: `Read-only` or `Read-write`, limited by current product/server policy.

Derived read-only fields:

- provider;
- remote;
- repository slug;
- default branch;
- current HEAD;
- dirty/clean state.

Primary CTA: `Create workspace`.

### Step 7 — Runtime

Progress phases:

```text
Validating repository
Preparing managed state
Starting daemon
Checking plugin/MCP availability
Final readiness checks
```

Display bounded runtime progress and current stage. SourceNerve does not index or analyze the repository during onboarding.

### Step 8 — Ready

Success state:

```text
SourceNerve is ready

Account        Connected
GitHub         Connected
Workspace      my-api
Repository     owner/my-api
Public MCP     Ready
```

CTAs:

- `Open workspace`
- `Connect ChatGPT Plugin`

## Overview dashboard

Layout:

```text
+---------------------------+ +---------------------------+
| SourceNerve Account       | | Git Provider              |
| Connected                 | | GitHub · khovan123        |
| user@example.com          | | API Ready / Push Ready    |
+---------------------------+ +---------------------------+

+---------------------------+ +---------------------------+
| SourceNerve Daemon        | | Public MCP                |
| Ready · vX.Y.Z            | | Ready                     |
| 127.0.0.1:7331            | | assigned-host.example     |
| Restart                   | | Check / Repair            |
+---------------------------+ +---------------------------+

+----------------------------------------------------------------+
| Workspaces                                                     |
| my-api        Ready       Read-write     daemon ready           |
| web-ui        Needs attention Read-only   provider unavailable    |
+----------------------------------------------------------------+
```

### Status vocabulary

Use the same vocabulary across screens:

- Ready
- Working
- Needs attention
- Degraded
- Offline
- Expired
- Revoked
- Stale
- Read-only
- Read-write

Avoid ambiguous labels such as `Unknown` when the app can state the failing layer.

## Workspace list

Each workspace card/row shows:

- name and ID;
- repository slug;
- local root using compact path display;
- current branch/HEAD short SHA;
- dirty/clean state;
- read-only/read-write badge;
- provider status.

Row actions:

- Open
- Edit workspace metadata
- Remove from SourceNerve

`Remove` explicitly says repository files will not be deleted.

## Workspace detail

Tabs:

```text
Summary | Repository | Extensions | Access | Activity
```

### Summary

Repository, current branch/HEAD, dirty state, access mode, runtime health, and recent SourceNerve activity.

### Repository

Remote/default branch/provider/repository slug and validation status. Values are automatically derived where possible.

### Extensions

Workspace-visible plugin skills and MCP extensions. Specialized code search, symbol/graph, semantic, architecture, and language intelligence is owned by those extensions rather than the SourceNerve core.

### Access

Effective SourceNerve access and Auth0 subject/account summary. Normal users cannot edit raw subject-to-workspace grant records.

### Activity

Recent task/runtime/provider/plugin events with no secret-bearing logs.

## External repository intelligence

SourceNerve does not provide a built-in Intelligence screen. Repository search, symbol/graph exploration, semantic retrieval, architecture views, and context assembly may be exposed by installed plugin skills or MCP extensions. Desktop surfaces their availability through Plugins/MCP management and task/Harness activity rather than duplicating those tools.

## Guarded task/change workflow

Task detail uses a stepper:

```text
1. Task
2. Branch
3. Intent / Evidence
4. Proposal
5. Apply
6. Review
7. Commit
8. Push
9. Pull Request
10. Merge / Sync
```

The UI never compresses all steps into one destructive `Finish` button.

### Task

Shows objective, workspace, base HEAD, snapshotted working-tree state, lifecycle state, and staleness warnings.

### Branch

Feature branch name and checkout status. Default branch direct mutation is never offered.

### Intent / Evidence

Shows the task intent plus exact SourceNerve file/Git evidence and any explicitly attributable plugin/MCP context used by the agent. SourceNerve does not persist a built-in repository context pack.

### Proposal

Full proposed patch preview with per-file expectations.

CTA: `Apply proposal` requires explicit confirmation.

### Apply

Server-side guard result shown verbatim in safe user language: expected HEAD mismatch, file SHA mismatch, read-only workspace, stale proposal, etc.

### Review

Full applied diff plus review hash/gate state. Commit is disabled until review gate is satisfied.

### Commit

Commit message and exact reviewed state. No amend/reset/force options in MVP.

### Push

Destination remote/branch and exact commit SHA displayed before push.

### Pull Request

Provider, repository, base/head and expected pushed SHA.

### Merge / Sync

Merge is a separate explicit operation. Confirmation must show:

- repository;
- PR/MR number;
- base branch;
- expected head SHA;
- merge method.

After successful merge, present `Sync default branch` separately.

## Pull Requests screen

Filters:

- workspace;
- provider;
- open/draft/merged;
- current task.

Detail:

- PR/MR number/title;
- provider state;
- base/head;
- expected/current head SHA;
- review/check/protection summary;
- SourceNerve task association;
- refresh action;
- guarded merge action when allowed.

Provider protection failures are described as provider-owned constraints; SourceNerve never claims to bypass them.

## Connections

Connections page contains four cards.

### SourceNerve Account

Displays Auth0-backed identity and session health.

Actions:

- Sign in
- Re-authenticate
- Sign out

No raw token display.

### GitHub/GitLab

Displays provider account and API/push capabilities.

Actions:

- Connect
- Re-authenticate
- Disconnect

### ChatGPT Plugin

Displays:

- public MCP readiness;
- plugin metadata readiness;
- Auth0 compatibility;
- tool discovery readiness;
- Open Plugin page;
- Verify again.

Manual OpenAI UI tasks are explained but not automated.

### Public MCP

Displays:

- Ready / Degraded / Offline;
- assigned public hostname;
- last health check;
- protected-resource/OIDC/tool-discovery summary.

Actions:

- Check
- Repair
- Re-enroll, only when required.

No Cloudflare token or tunnel-ID field exists in normal UI.

## Logs & Diagnostics

### Live logs

Structured list with:

- timestamp;
- component: Desktop / Daemon / Tunnel / Auth / Git / Provider;
- level;
- sanitized message.

Filters:

- component;
- level;
- text;
- time range.

Sensitive values and Authorization headers are redacted before renderer publication.

### Diagnostics

Cards for:

- Desktop build/version;
- daemon version;
- bootstrap profile version;
- OS/arch;
- Auth0 status;
- Git provider status;
- secure-store status;
- daemon health;
- tunnel/public MCP health;
- workspace/index health.

Recovery actions:

- Restart daemon
- Retry public MCP
- Rebuild index
- Re-authenticate SourceNerve
- Re-authenticate Git
- Export support bundle

### Support bundle

Before export, display exactly which categories will be included and allow the user to preview sanitized data.

Repository source bodies, full diffs, patches, tokens and secrets are excluded.

## Settings

Normal settings sections:

```text
General
Appearance
Startup & Background
Updates
Notifications
Advanced Diagnostics
```

### General

- default workspace behavior;
- confirmation preferences where policy permits;
- open external links preference.

### Appearance

- System / Light / Dark;
- density: Comfortable / Compact.

### Startup & Background

- launch at login;
- close window: quit or keep in tray;
- background daemon behavior.

### Updates

- stable channel;
- automatic download preference;
- current Desktop/daemon/profile versions.

### Advanced Diagnostics

Read-only product values may be shown for support:

- daemon bind/port;
- Auth0 issuer/resource;
- Bootstrap Broker URL;
- public MCP hostname;
- profile schema version.

Raw Cloudflare/local-bearer/Auth0/Git secret values are never shown.

## Explicit non-screens

The normal product must not contain setup forms for:

- Cloudflare tunnel token;
- Cloudflare account API token;
- SourceNerve local bearer token;
- Auth0 access/refresh token;
- Auth0 Management API token;
- OAuth issuer/resource/scopes;
- MCP hostname/resource;
- Auth0 tenant provisioning;
- raw `sourcenerve.toml` editor;
- raw environment variable editor;
- arbitrary shell command runner.

## Cross-product state model

Every major runtime layer reports one state object with safe fields only.

```text
SourceNerve Account: connected | expired | revoked | disconnected
Git Provider:        connected | degraded | disconnected
Daemon:              ready | starting | stopped | crashed | incompatible
Public MCP:          ready | degraded | offline | enrolling
Workspace:           ready | invalid | unavailable
Task:                draft | branched | proposed | applied | reviewed |
                     committed | pushed | pr_open | merged | cancelled | stale
```

Renderer displays state; Electron Main/daemon owns secrets and privileged operations.

## Error-state interaction rules

### Product profile invalid

Message: `This SourceNerve build has an invalid product configuration.`

Actions: `Retry`, `View diagnostics`, `Check for update`.

Do not open a raw config form.

### Secure storage unavailable

Message states the platform secure-storage problem and blocks token acquisition/storage until repaired.

### Auth expired

Re-authenticate only Auth0. Preserve Git and workspace state.

### Git expired

Re-authenticate only provider. Preserve Auth0 and workspace state.

### Daemon crashed

Show exit summary and sanitized logs. `Restart` is explicit.

### Tunnel degraded

Show last working time, safe reason, and `Retry` / `Repair` without token entry.

### External intelligence unavailable

Show the affected plugin/MCP provider as unavailable or degraded without marking the SourceNerve workspace itself stale. Exact file/Git primitives remain available when the workspace/runtime is healthy.

### Task stale

Disable further mutation until task state is refreshed/recovered through server-side guards.

## Confirmation policy

Always require explicit confirmation before:

- removing a SourceNerve workspace registration;
- applying a patch;
- cancelling a task that has unapplied proposal/work;
- committing;
- pushing;
- creating an external issue/PR/MR;
- merging;
- rotating/re-enrolling public routing when it changes installation identity;
- resetting local Desktop state.

Confirmation dialogs state concrete target values. Generic `Are you sure?` copy is insufficient.

Example merge confirmation:

```text
Merge PR #42?
Repository: owner/my-api
Base: main
Head: feat/task-123
Expected head: 1a2b3c4
Method: squash

This action changes the remote repository.
```

## Read-only vs read-write presentation

Read-only workspace badge is persistent beside the workspace selector.

For read-only workspaces:

- hide/disable New Task mutation CTA;
- hide patch/apply/commit/push/PR-create/merge actions;
- keep exact read-only file/Git primitives and permitted plugin/MCP read capabilities available;
- explain that effective access is read-only rather than presenting a generic permission error after click.

## Command palette and keyboard shortcuts

Decision: include a command palette, but only for safe semantic navigation/actions.

Shortcut:

- macOS: `Cmd+K`
- Windows/Linux: `Ctrl+K`

Allowed examples:

- Switch workspace
- Open plugin/MCP tools
- Open workspace files
- Open tasks
- Open diagnostics
- Restart daemon, with confirmation if required

Forbidden palette commands:

- arbitrary shell;
- arbitrary HTTP;
- force push/reset;
- secret reveal;
- direct default-branch mutation.

Additional shortcuts:

- `Ctrl/Cmd+P`: workspace/file quick open;
- `Ctrl/Cmd+,`: settings;
- `Ctrl/Cmd+Shift+L`: logs.

## Visual system

### Theme

Support System, Light, and Dark from the first scaffold.

### Density

Default is compact developer-tool density without reducing click-target accessibility. Tables may use Compact/Comfortable density preference.

### Semantic emphasis

Use semantic tokens rather than hardcoded feature colors:

- success/ready;
- warning/degraded/stale;
- danger/destructive/revoked;
- info/working;
- neutral/disconnected.

### Destructive UI

Destructive/external actions use stronger visual treatment only at the final explicit action, not throughout the workflow.

### Icons

Use one consistent icon library. Do not encode status by icon/color alone; pair with text.

## Issue-to-screen mapping

| Issue | UX surface |
|---|---|
| #62 | First-run onboarding |
| #63 | Workspaces list/detail and repository picker |
| #64 | Git provider connection and repository discovery |
| #65 | SourceNerve Account connection/access summary |
| #66 | Public MCP status/repair |
| #67 | Overview + live logs |
| #68 | Intelligence |
| #69 | Tasks & Changes |
| #70 | Pull Requests |
| #71 | ChatGPT Plugin connection |
| #72 | Tray/startup/background Settings |
| #73 | Import existing setup entry point |
| #74 | Logs & Diagnostics/support bundle |
| #83 | Hidden product bootstrap + safe status surfaces |
| #84 | Secure bootstrap progress/public routing state |

## Responsive behavior

Desktop MVP targets standard laptop/desktop windows, not mobile layout.

Minimum supported content width should preserve the persistent navigation plus a usable code/diff viewport. Below that threshold, navigation may collapse to icons, but core task confirmation data must never be truncated without an expansion affordance.

Large tables use virtualization/pagination rather than growing unbounded.

## Accessibility baseline

- all actions keyboard reachable;
- visible focus states;
- semantic headings/labels;
- no status conveyed by color alone;
- dialogs trap focus correctly;
- diff/code views expose text alternatives where custom rendering is used;
- interactive target sizes remain usable in Compact density.

## Acceptance checklist

This UX spec is complete when implementation can answer all of the following without inventing new normal-user setup flows:

- where does a new user sign in to SourceNerve? — onboarding/account card;
- where do they connect Git? — onboarding/Connections;
- where do they choose repo/workspace? — onboarding/Workspaces;
- where do they see daemon/tunnel failures? — Overview/Diagnostics;
- where do they search/inspect graph? — Intelligence;
- where do they make guarded changes? — Tasks & Changes;
- where do they manage PR/MR state? — Pull Requests;
- where do they connect ChatGPT Plugin? — Connections;
- where do they see a Cloudflare token? — nowhere;
- where do they see a local bearer? — nowhere;
- where do they edit raw OAuth/TOML/env? — nowhere in standard UI;
- how is read-only visible? — persistent workspace badge plus mutation suppression;
- how are high-risk actions confirmed? — concrete target confirmation dialogs.

Implementation of #59 and later Desktop screens must follow this information architecture unless a subsequent ADR intentionally supersedes it.
