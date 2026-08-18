# Durable outbound lifecycle callbacks

SourceNerve can optionally deliver sanitized lifecycle notifications to one explicitly configured HTTP endpoint. The callback channel is a notification mechanism only: callback responses cannot trigger repository mutations, retries of repository work, LLM execution, or pull-request merges.

## Enable

Configure both environment variables together:

```text
SOURCENERVE_CALLBACK_URL=https://receiver.example.com/sourcenerve
SOURCENERVE_CALLBACK_SECRET=<32-256 ASCII bytes>
```

The callback URL and secret are environment-only. They are intentionally not accepted from TOML and cannot be supplied dynamically by an ingress request.

When callbacks are not configured:

- new task/job/GitHub events do not reserve callback deliveries;
- no callback worker runs;
- `/api/v1/callbacks/get` and `/api/v1/callbacks/retry` are not mounted.

Pending deliveries from a previously enabled deployment remain durable in SQLite and can resume if the same state database is started again with callbacks enabled.

## Development loopback mode

Production callback URLs must use HTTPS and resolve to globally routable addresses.

A local development/test receiver may be enabled explicitly with:

```text
SOURCENERVE_CALLBACK_URL=http://127.0.0.1:18765/callback
SOURCENERERVE_CALLBACK_SECRET=<32-256 ASCII bytes>
SOURCENERVE_CALLBACK_ALLOW_INSECURE_LOOPBACK=true
```

The insecure mode accepts only a literal loopback IP. A hostname such as `localhost`, a private RFC1918 address, or a non-loopback HTTP target is rejected.

> Note: the correct secret variable is `SOURCENERVE_CALLBACK_SECRET`; the example name above should always use that exact spelling in deployment configuration.

## Network safety

Before every production delivery attempt SourceNerve:

1. validates the configured URL shape;
2. rejects URL credentials, fragments, controls, whitespace, unsupported host characters and zero/invalid ports;
3. resolves the destination again for the attempt;
4. rejects loopback, private, link-local, carrier-grade NAT, benchmark, documentation, multicast and other non-public address classes;
5. pins one validated public DNS answer into the transport connection;
6. does not follow HTTP redirects;
7. bounds connection time, total request time and received response bytes.

The transport is invoked directly as a fixed `curl` subprocess without a shell. Callback payload data is written through stdin and cannot become command-line shell syntax.

SourceNerve does not persist callback response bodies or transport stderr. Only bounded status/error codes such as `http_503`, `curl_exit_7`, or `callback_dns_failed` are stored.

## Durable outbox

Schema version 10 adds `callback_outbox` plus a singleton callback runtime state.

When callbacks are enabled, SQLite triggers reserve an outbox source reference in the same transaction that inserts one of these durable source events:

- `task_events`;
- `job_events`;
- accepted `github_webhook_deliveries`.

This means the source event cannot commit successfully while its required callback reservation is lost because of a process crash between application statements.

The outbox stores only routing/status metadata and a source reference. It does not copy source event metadata, context queries, source code, patches, diffs, review text, raw provider payloads or secrets into the outbox.

Events created while callbacks are disabled are not retroactively backfilled when callbacks are later enabled.

## Callback envelope

Every request is JSON and uses a stable delivery ID:

```json
{
  "schema_version": 1,
  "delivery_id": "32-hex-character-id",
  "event": {
    "kind": "task",
    "source_event": "task_begun",
    "workspace": "workspace-id",
    "task_id": "task-id",
    "job_id": null,
    "task_status": "active",
    "lifecycle_phase": "snapshot",
    "occurred_at": 0
  }
}
```

Job envelopes expose only IDs and derived job/task/lifecycle status. GitHub envelopes expose the same sanitized provider facts already allowed by GitHub webhook observations: repository slug, pull number/head SHA, pull state/merged flag, check status/conclusion and review state.

The callback body never includes:

- context query/prompt text;
- repository source contents;
- patch or diff bodies;
- review bodies or check output text;
- raw webhook request bodies;
- GitHub/API/bearer/callback secrets;
- actor email addresses;
- absolute host workspace paths.

## Signature

SourceNerve signs the exact outbound body with HMAC-SHA256 using `SOURCENERVE_CALLBACK_SECRET`.

Headers:

```text
Content-Type: application/json
X-SourceNerve-Delivery: <delivery-id>
X-SourceNerve-Event: <task_event|job_event|github_observation>
X-SourceNerve-Signature: sha256=<hex-hmac>
```

Receivers should verify the HMAC against the exact raw request body before parsing JSON and should use `X-SourceNerve-Delivery` as their own idempotency key.

## Retry and recovery

A delivery moves through:

```text
pending -> delivering -> delivered
                     \-> pending (bounded retry)
                     \-> failed  (terminal after max attempts)
```

Retries use deterministic exponential backoff starting at two seconds, capped at five attempts and a 300-second delay ceiling.

On SourceNerve startup, an interrupted `delivering` row is returned to `pending`, so a crash during an in-flight request is recovered. Because a network response may have reached the receiver immediately before a process crash, receivers must treat the stable delivery ID as an idempotency key and safely accept replay.

Successful `2xx` deliveries are not sent again by the worker. Non-2xx responses and bounded transport/DNS failures enter retry processing.

## Inspect and explicitly retry

While callbacks are enabled, authenticated clients can inspect one delivery:

```text
POST /api/v1/callbacks/get
Authorization: Bearer <token>
Content-Type: application/json

{"delivery_id":"<id>"}
```

A terminal `failed` delivery can be explicitly reset:

```text
POST /api/v1/callbacks/retry
Authorization: Bearer <token>
Content-Type: application/json

{"delivery_id":"<id>"}
```

Explicit retry resets the bounded attempt/error state and returns the delivery to `pending`. It does not run repository mutations.

## Operational boundary

Outbound callbacks do not add:

- autonomous merge behavior;
- callback-driven shell execution;
- callback-driven LLM execution;
- per-request/dynamic callback URLs;
- distributed multi-writer coordination.

The durable task engine, exact-head guards, review requirements and GitHub branch protections remain authoritative for repository changes.
