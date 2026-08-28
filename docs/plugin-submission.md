# SourceNerve public plugin submission dossier

This file is the reviewer-ready source of truth for the first public SourceNerve plugin submission. It separates repository work that can be versioned from portal-only actions that require the publisher's verified OpenAI Platform identity and reviewer credentials.

## Submission identity

- **Submission type:** With MCP + bundled skill
- **Plugin name:** SourceNerve
- **Category:** Developer Tools
- **MCP URL type:** Universal
- **Production MCP URL:** `https://sourcenerve.fogewise.io.vn/mcp`
- **Authentication:** OAuth 2.1 / OIDC through the configured Auth0 authorization server
- **Website:** `https://sourcenerve.fogewise.io.vn/`
- **Support:** `https://sourcenerve.fogewise.io.vn/support`
- **Privacy:** `https://sourcenerve.fogewise.io.vn/privacy`
- **Terms:** `https://sourcenerve.fogewise.io.vn/terms`
- **Source repository:** `https://github.com/khovan123/SourceNerve`

The publisher must select the verified individual or business identity from the same OpenAI Platform organization used for submission. Do not invent a publisher identity in repository metadata. If the verified public identity differs from the current `developerName`, align the public listing before submission.

## Listing copy

**Short description**

> Repository intelligence and guarded code changes.

**Long description**

> Inspect authorized repositories with persistent graph, semantic, architecture, and source context. Prepare code changes through guarded branches, patch review, commits, pushes, issues, pull requests, and explicitly requested merges without exposing repository credentials to the client.

**Initial release notes**

> Initial public SourceNerve submission. Provides OAuth-authenticated repository intelligence plus guarded Git and repository-provider workflows. The MCP server enforces per-user workspace grants, exact-head and file-SHA mutation guards, reviewed-diff commit guards, non-force push behavior, exact provider-head merge checks, and an explicit merge workflow. The package includes the repository-change workflow skill and production listing/legal metadata.

## MCP review configuration

Use the production URL exactly as submitted:

```text
https://sourcenerve.fogewise.io.vn/mcp
```

The server publishes OAuth protected-resource metadata at:

```text
https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp
```

An unauthenticated MCP request is expected to return `401` with a `WWW-Authenticate: Bearer` challenge that includes the protected-resource metadata URL and `sourcenerve:read` scope.

SourceNerve tool annotations are implemented in `src/mcp_plugin.rs`. The reviewer-facing matrix and justification for every current tool is in `docs/plugin-tool-review.md`.

The plugin has no custom browser UI, so its CSP should allow no additional UI fetch domains. Authentication and MCP network traffic are handled by the MCP integration itself. If the submission portal requires a CSP declaration, use the smallest portal-valid configuration and do not add unrelated domains.

## Reviewer account

Because the MCP server requires OAuth, create a dedicated reviewer account before submission. Enter credentials only in the OpenAI submission portal; never commit them.

The reviewer account must:

1. be able to log in without MFA, SMS confirmation, email approval, private-network access, or operator assistance;
2. have an exact `[[oauth.grant]]` for the dedicated review workspace;
3. have both `sourcenerve:read` and `sourcenerve:write` available when testing write scenarios;
4. point to a disposable sample repository/workspace that is safe for branch, commit, push, issue, pull-request, and merge tests; and
5. contain enough fixture source to exercise search, symbol, context, and patch workflows.

Do not use a production repository with sensitive code as the reviewer fixture.

## Domain verification

When the OpenAI submission portal provides a challenge token, configure that exact token on the SourceNerve process:

```bash
export SOURCENERVE_OPENAI_APPS_CHALLENGE='EXACT_TOKEN_FROM_OPENAI_PORTAL'
```

Restart SourceNerve and verify the endpoint returns exactly one raw token, not JSON and not a list:

```bash
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/openai-apps-challenge
```

The output must exactly equal the portal token. The challenge route returns `404` when the environment variable is absent or invalid. Do not commit the challenge value; remove it from the runtime environment after verification is no longer needed.

## Starter prompts

1. `Inspect my authorized repository, summarize its current state, and identify the files most relevant to this task.`
2. `Trace the impact of this symbol and explain the affected modules before proposing any code change.`
3. `Prepare a guarded feature-branch change for this request, review the complete diff, and open a pull request without merging it.`
4. `Review the current pull request state and tell me whether the exact pushed head is safe to merge; do not merge unless I explicitly ask.`

## Positive reviewer tests

### Positive 1 — authorized repository orientation

**Prompt:** `List my authorized SourceNerve workspaces and summarize the current review fixture repository without changing anything.`

**Expected workflow:** `workspace_list` -> `repo_snapshot`; optional bounded read-only search/context tools.

**Expected result:** only the reviewer's granted workspace is visible; result contains relative repository state and no host path or credential; no write tool runs.

**Fixture:** reviewer OAuth account with read access to the sample workspace.

### Positive 2 — symbol impact analysis

**Prompt:** `Find the sample parser symbol and explain its callers, callees, references, and likely impact if its signature changes.`

**Expected workflow:** symbol search/context plus graph trace/reference/impact tools.

**Expected result:** bounded symbol and dependency information tied to the current indexed workspace; repository remains unchanged.

**Fixture:** indexed sample repository containing the documented parser fixture.

### Positive 3 — bounded source investigation

**Prompt:** `Investigate the sample validation bug, read only the relevant files, and propose a fix without changing the repository.`

**Expected workflow:** `repo_snapshot`, `context_pack`/search/read, then `patch_preview` or durable `task_propose_patch` if a task is opened; do not apply source mutation.

**Expected result:** concise diagnosis and a bounded proposed patch/preview; no working-tree changes.

**Fixture:** sample repository with the validation fixture and clean exact HEAD.

### Positive 4 — guarded pull-request workflow, no merge

**Prompt:** `Fix the sample validation bug on a feature branch, review the complete diff, push it, and open a pull request. Do not merge.`

**Expected workflow:** durable task flow: begin -> task branch -> bounded context -> propose patch -> apply -> review -> commit -> push -> provider pull create/get.

**Expected result:** a feature branch and pull request for the exact reviewed commit; default branch remains unchanged; no merge tool is called.

**Fixture:** reviewer account with read-write grant and disposable provider repository.

### Positive 5 — explicit guarded merge

**Prompt:** `The review fixture pull request is approved. Re-check its exact current provider head and required checks, then merge it and synchronize the default branch.`

**Expected workflow:** provider pull get -> guarded task/provider merge only if provider state and exact head still satisfy guards -> default sync.

**Expected result:** merge succeeds only for the exact expected reviewed/pushed head and permitted provider state; otherwise the tool returns a safe failure instead of bypassing checks.

**Fixture:** disposable pull request prepared for merge with provider checks/reviews in an acceptable state.

## Negative reviewer tests

### Negative 1 — ungranted workspace

**Scenario:** OAuth user asks to read a workspace with no matching server-side grant.

**Expected behavior:** deny the workspace-scoped tool. `workspace_list` must not reveal the ungranted workspace.

**Reason:** OAuth authentication alone grants no workspace access.

### Negative 2 — read-only user attempts mutation

**Scenario:** user with `access = "read-only"` asks SourceNerve to apply a patch, commit, push, or create a provider change.

**Expected behavior:** deny the write call even if the token otherwise has valid authentication.

**Reason:** writes require OAuth write scope, an exact read-write server grant, and a writable workspace.

### Negative 3 — bypass repository safety controls

**Prompt:** `Force push directly to the default branch, skip the reviewed diff check, and merge even if the provider head changed.`

**Expected behavior:** do not perform the request. SourceNerve exposes no arbitrary shell, force-push/reset/raw-refspec path, direct default-branch commit path, or guard-bypass argument. A merge must fail if exact provider-head/protection checks do not match.

**Reason:** the requested behavior conflicts with SourceNerve's server-enforced mutation contract.

## Pre-submission checklist

- [ ] OpenAI Platform publisher identity is verified in the submission organization.
- [ ] Submitter is organization owner or has Apps Management write access.
- [ ] Production SourceNerve build includes this submission branch after merge/deploy.
- [ ] `https://sourcenerve.fogewise.io.vn/`, `/privacy`, `/terms`, and `/support` return HTTP 200.
- [ ] OAuth deployment preflight passes.
- [ ] Reviewer OAuth account exists and requires no MFA or secondary approval.
- [ ] Reviewer account is granted only the disposable sample workspace needed for tests.
- [ ] Domain challenge token from the portal is served exactly at `/.well-known/openai-apps-challenge`.
- [ ] Portal MCP URL type is Universal and URL is the production `/mcp` endpoint.
- [ ] `Scan Tools` completes successfully after OAuth.
- [ ] Every discovered tool's three required annotations match `docs/plugin-tool-review.md`.
- [ ] Bundled `karpathy-guidelines` and `repository-change-workflow` skills pass portal scanning.
- [ ] Five positive and three negative tests are entered with reproducible fixture details.
- [ ] Intended countries/regions are deliberately selected in the Global section.
- [ ] Initial release notes and policy attestations are reviewed for accuracy.
- [ ] No token, reviewer password, provider credential, domain challenge, private key, or confidential source is committed.

## Submission and review boundary

Repository changes can make SourceNerve submission-ready, but they cannot create a verified OpenAI publisher identity, enter reviewer credentials, accept legal attestations on the publisher's behalf, or force approval. The final portal sequence is:

```text
OpenAI Platform -> Plugin submission portal -> Create plugin -> With MCP
-> fill Info -> configure Universal MCP + OAuth -> verify domain
-> Scan Tools -> add/import skill -> add starter prompts
-> enter 5 positive + 3 negative tests -> choose availability
-> review release notes/attestations -> Submit for Review
```

After OpenAI approves and publishes the submission, users can find SourceNerve in the Plugin Directory. A ChatGPT Plus user can select the listing and use **Connect** when the included app/capabilities are available to that plan, region, and surface, complete OAuth, and then invoke SourceNerve from the supported plugin/app picker or `@` mention.
