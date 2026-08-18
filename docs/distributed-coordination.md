# Distributed mutation coordination

SourceNerve uses SQLite-backed renewable leases as an additive coordination layer for deployments where more than one service process can access the same state database and workspace.

Git and the existing optimistic-concurrency checks remain authoritative. The lease does not replace expected Git HEAD, reviewed diff SHA-256, file hashes, or provider-side expected-head guards.

## Lease model

`mutation_leases` stores one row per mutation resource:

- opaque owner instance ID;
- opaque lease ID;
- monotonically increasing fencing token;
- acquisition/renewal timestamps;
- expiration timestamp.

A new holder may acquire a resource only when no live lease exists. Taking over a released or expired row increments the fencing token. A stale holder whose token is older than the current row fails `assert_current` and cannot clear the newer lease during drop cleanup.

The initial production lease TTL is 30 seconds and the holder renews every 10 seconds. Lease identifiers and runtime instance IDs are never exposed through REST/MCP status. Authenticated readiness exposes only the coordination mode plus aggregate active/owned lease counts.

## Failure behavior

- A live competing holder causes the mutation request to fail closed.
- A crashed process stops renewing; after expiration a new process can take over without manual database cleanup.
- Lease cleanup matches owner + lease ID + fencing token, so a delayed cleanup cannot release a replacement lease.
- Losing a lease makes the next fence assertion fail closed.
- SQLite/network/filesystem errors do not grant a lease optimistically.

## Deployment boundary

This milestone targets multiple SourceNerve processes sharing a SQLite state database on one coherently locked host/storage domain. It is not a distributed consensus system and does not claim to make SQLite safe on filesystems that do not provide SQLite's required locking guarantees.

For multi-host deployments, use storage with correct SQLite locking semantics and ensure all instances see the same Git workspaces. A future storage backend may move coordination to a dedicated consensus-capable service; clients do not depend on lease IDs, so that can remain a server-side change.

## Current protected entry points

The coordination primitive is wired first into full workspace indexing and reviewed patch application, the two mutation paths that directly replace repository-intelligence/source state. Existing in-process mutation locking remains in place as a second layer for process-local serialization.

Additional mutation APIs retain their existing exact-head/idempotency/provider guards and can adopt the same workspace lease primitive without changing the public request contracts.
