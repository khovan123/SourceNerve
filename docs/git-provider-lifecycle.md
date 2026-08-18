# Repository-host provider lifecycle

SourceNerve separates guarded local Git/task state from repository-host API operations. Git remains the source of truth for the local workspace; the configured repository host is used only for issue and change-request lifecycle operations.

## Workspace configuration

Repository-host lifecycle is explicit for new configurations:

```toml
[[workspace]]
id = "repo"
name = "Repository"
root = "/absolute/path/to/repository"
access = "read-write"
remote = "origin"
default_branch = "main"
provider = "github"
repository = "owner/repository"
```

Supported providers in this milestone are `github` and `gitlab`.

GitHub keeps backward compatibility with the legacy field:

```toml
github_repository = "owner/repository"
```

A legacy `github_repository` entry is interpreted as `provider = "github"`. New provider-neutral `repository` configuration requires an explicit provider. Unsupported providers fail closed and are never silently treated as GitHub.

For GitLab, repository slugs may include subgroups:

```toml
provider = "gitlab"
repository = "group/subgroup/project"
```

If the explicit repository slug is omitted, provider-specific inference is allowed only from standard remotes for the selected host (`github.com` for GitHub and `gitlab.com` for GitLab).

## Provider-neutral task lifecycle

The authenticated task REST routes are already provider-neutral:

```text
POST /api/v1/tasks/lifecycle/issues/create
POST /api/v1/tasks/lifecycle/pulls/create
POST /api/v1/tasks/lifecycle/pulls/get
POST /api/v1/tasks/lifecycle/pulls/merge
```

The workspace provider decides which adapter is used. Lifecycle responses carry a `provider` discriminator and provider-neutral issue/change-request/merge result shapes.

MCP adds provider-neutral aliases:

```text
task_provider_issue_create
task_provider_pull_create
task_provider_pull_get
task_provider_pull_merge
```

The existing `task_github_*` MCP names remain as backward-compatible aliases. They still dispatch through the configured workspace provider; callers should use the provider-neutral names for new integrations.

## GitHub

Existing GitHub behavior is intentionally preserved. `SOURCENERVE_GITHUB_TOKEN` remains server-side and the existing guarded GitHub operations continue to use their established idempotency and audit records.

GitHub webhook observations are explicitly tagged with `provider: "github"`. Webhook linking considers only workspaces configured as GitHub, so a GitLab workspace with a similar repository slug cannot be linked to a GitHub delivery.

## GitLab

Configure the GitLab token only on the SourceNerve server:

```bash
export SOURCENERVE_GITLAB_TOKEN='<server-side token>'
```

Production API traffic is fixed to:

```text
https://gitlab.com/api/v4
```

The production endpoint cannot be replaced by a client. A literal loopback HTTP override exists only for controlled local/CI tests and requires both:

```bash
export SOURCENERVE_GITLAB_API_URL='http://127.0.0.1:7445/api/v4'
export SOURCENERVE_GITLAB_ALLOW_INSECURE_LOOPBACK=true
```

The override rejects hostnames, credentials, fragments and non-loopback targets.

GitLab operations implemented in this milestone:

- create issue;
- create merge request;
- get merge request;
- merge merge request with exact expected-head verification.

GitLab merge methods are `merge` and `squash`. SourceNerve does not bypass GitLab project policies, approvals, checks or authorization.

## Safety and idempotency

Repository-host operations do not weaken the existing task/Git contracts:

1. Branch checkout starts from the task base HEAD and a clean default branch.
2. Applied patches must be reviewed before commit.
3. Commit is tied to the reviewed diff.
4. Push is non-force and verifies the remote feature-branch SHA.
5. Change-request creation requires the pushed remote branch to equal local HEAD.
6. Merge re-reads the provider change request and requires its current head SHA to equal the exact task push SHA.
7. Provider mutation retries use provider-specific idempotency namespaces.

For GitLab, request bodies and responses are bounded, execution is time bounded, provider stderr/raw error bodies are not returned, and the token is supplied to `curl` through stdin rather than argv. Temporary request bodies use restrictive permissions on Unix and are removed after the request.

Credentials, provider API URLs and executable paths are not accepted from clients and are not included in lifecycle responses.

## Restart behavior

Durable task lifecycle and idempotency state remain in SQLite. After restart, SourceNerve rebuilds provider runtime configuration from server environment and can replay completed issue/MR operations without creating duplicates when the same task-derived idempotency key and fingerprint are used.

## Non-goals

This milestone does not add:

- Bitbucket implementation yet;
- arbitrary custom repository-host endpoints;
- client-supplied provider credentials;
- generic shell execution;
- automatic merge without the existing explicit merge call and expected-head gate;
- autonomous model execution or code generation.

The provider facade is the extension point for future Bitbucket support without changing the local Git/task transaction model.