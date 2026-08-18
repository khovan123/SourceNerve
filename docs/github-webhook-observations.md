# GitHub lifecycle webhook observations

SourceNerve can optionally receive signed GitHub lifecycle events for pull requests that are already linked to durable SourceNerve tasks. This removes the need for a client to repeatedly poll GitHub merely to learn that checks, reviews, or pull-request state changed.

The webhook is observational. It does not execute an LLM, run arbitrary shell commands, create patches, retry CI, or merge a pull request.

## Enable

Set an environment-only secret:

```text
SOURCENERVE_GITHUB_WEBHOOK_SECRET=<32-256 ASCII bytes>
```

When the variable is absent, `/webhooks/v1/github` is not mounted and therefore returns the normal `404 Not Found` response.

Configure the GitHub repository webhook URL as:

```text
POST https://<sourcenerve-host>/webhooks/v1/github
```

Use the same secret in the GitHub webhook configuration. SourceNerve validates the standard `X-Hub-Signature-256` HMAC-SHA256 over the exact raw request body before parsing JSON.

The endpoint also requires bounded `X-GitHub-Delivery` and `X-GitHub-Event` headers. Request bodies are limited to 256 KiB.

## Initial event set

The production baseline accepts sanitized observations from:

- `pull_request`
- `pull_request_review`
- `check_run`
- `check_suite`

Unsupported events are safely ignored after authentication. They do not mutate task lifecycle state.

For check events, SourceNerve links the event only when GitHub identifies exactly one pull request. Empty or ambiguous pull-request lists are ignored instead of guessed.

## Exact linkage contract

A valid signature is necessary but not sufficient for an event to attach to a durable task.

SourceNerve additionally requires:

1. the GitHub `repository.full_name` to map uniquely to one configured workspace;
2. the pull-request number to match a persisted `task_lifecycle.pull_number` in that workspace;
3. the event head SHA to match the exact task `push_sha` (or the persisted pull head when recovering older state);
4. exactly one durable task to match those facts.

Unknown repositories, unrelated pull requests, duplicate workspace mappings, ambiguous task mappings, and changed head SHAs remain unlinked. SourceNerve never guesses a task from a repository-global pull-request number alone.

## Delivery idempotency

Accepted linked events are keyed by `X-GitHub-Delivery`.

- first delivery: persist one sanitized observation;
- same delivery ID + identical raw payload: return the previous accepted observation as a replay;
- same delivery ID + changed payload: reject the request before another observation can be created.

The request fingerprint is SHA-256 of the exact raw body, so replay behavior survives process restart.

## Persisted data

Schema version 9 stores only the provider facts needed for durable status and recovery:

- delivery ID and event/action;
- workspace and task linkage;
- repository slug;
- pull-request number and exact head SHA;
- bounded pull-request state / merged flag;
- bounded check status / conclusion;
- bounded review state;
- creation timestamp.

It does not persist the GitHub webhook secret, GitHub/API tokens, raw webhook bodies, pull-request/review text, check output text, source code, patches, diffs, actor email addresses, or absolute host paths.

A sanitized `github_webhook_observed` task event is also recorded for accepted deliveries.

## Read current observation

Authenticated `POST /api/v1/tasks/get` includes a root `github_observation` field when the task has accepted GitHub events.

Webhook-created jobs expose the same summary through authenticated `POST /api/v1/jobs/get` and MCP `job_get`.

The summary is bounded and includes only the latest known provider facts, for example:

```json
{
  "repository": "owner/repository",
  "pull_number": 42,
  "pull_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "pull_state": "open",
  "pull_merged": false,
  "latest_check_status": "completed",
  "latest_check_conclusion": "success",
  "latest_review_state": "approved",
  "last_event": "check_run",
  "last_action": "completed",
  "last_delivery_id": "...",
  "updated_at": 0
}
```

## Mutation boundary

GitHub observations do not authorize or perform the next mutation step. A client still explicitly requests merge through the existing task/GitHub lifecycle.

Before merge, SourceNerve re-reads GitHub and requires the current pull-request head to equal the exact task-pushed SHA. GitHub branch protection, required checks, required reviews, and provider authorization remain authoritative.

There is no background polling loop and no autonomous merge behavior in this milestone.
