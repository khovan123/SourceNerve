# Webhook job ingress

SourceNerve exposes an optional signed webhook that lets an external service create or resume a durable repository job without sharing the normal MCP/API bearer token.

The webhook is ingress only. It does not execute arbitrary shell commands, generate patches, poll CI, or merge pull requests. A successful submission creates or resumes the same durable task used by the existing task, patch, Git, and GitHub lifecycle tools.

## Enable

Set `SOURCENERVE_WEBHOOK_SECRET` to a 32-256 byte ASCII secret in the service environment. The secret is environment-only and is never accepted from `sourcenerve.toml` or returned through API/MCP responses.

When the variable is absent, `/webhooks/v1/jobs` is not mounted.

## Submit a job

`POST /webhooks/v1/jobs`

Headers:

- `Content-Type: application/json`
- `X-SourceNerve-Timestamp: <unix-seconds>`
- `X-SourceNerve-Signature: sha256=<hex-hmac>`

The signature is HMAC-SHA256 over the exact bytes:

```text
<timestamp>.<raw-request-body>
```

The timestamp must be within 300 seconds of the server clock and the request body is limited to 64 KiB. Signature validation happens on the raw body before JSON parsing.

Example body:

```json
{
  "client_request_id": "chatgpt:change-123",
  "workspace": "backend",
  "context_query": "update repository authentication flow",
  "context_max_bytes": 65536,
  "context_max_items": 20
}
```

`client_request_id` is the webhook idempotency key. Replaying the same key with the same workspace/context/budgets returns the existing job and task. Reusing the key with different inputs fails closed before another task can be created.

The first successful submission returns `201 Created`. An idempotent replay returns `200 OK`.

## Read job status

Use the normal bearer-authenticated API:

```text
POST /api/v1/jobs/get
Authorization: Bearer <service-token>
Content-Type: application/json

{"job_id":"<job-uuid>"}
```

The same operation is available to MCP clients as `job_get`.

Job state is derived from the linked task and task lifecycle instead of maintaining a second mutation state machine:

- `pending`: the idempotency reservation exists but the durable task is not linked yet
- `active`: task/lifecycle work can continue
- `stale`: the task snapshot no longer matches repository state
- `cancelled`: the task was cancelled
- `completed`: the task lifecycle reached default-branch sync completion

## Persisted data

`jobs` stores only the job ID, client request ID, request fingerprint, workspace ID, task ID, and timestamps. `job_events` stores only sanitized reservation/link metadata.

Webhook secrets, bearer/GitHub tokens, context query text, source contents, patch bodies, diffs, and absolute host paths are not persisted in job records/events.
