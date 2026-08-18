# Production observability

SourceNerve observability is opt-in. With the default environment, no Prometheus endpoint is mounted and no OpenTelemetry exporter runs.

## Prometheus metrics

Enable metrics:

```bash
export SOURCENERVE_METRICS_ENABLED=true
```

The default scrape endpoint is authenticated with the normal SourceNerve bearer token:

```text
GET /api/v1/metrics
Authorization: Bearer <service-token>
```

A public scrape endpoint is available only when the operator explicitly enables it:

```bash
export SOURCENERVE_METRICS_PUBLIC=true
```

This mounts `GET /metrics` without bearer authentication. Do not enable it on an Internet-facing listener unless network policy protects the endpoint.

Workspace IDs are redacted from metric labels by default. To include bounded workspace IDs:

```bash
export SOURCENERVE_METRICS_INCLUDE_WORKSPACE=true
```

Only workspace IDs up to 64 safe identifier characters are emitted. Invalid or unbounded values collapse to `other`.

### Metric families

SourceNerve exports the following Prometheus-compatible metric families when metrics are enabled:

- `sourcenerve_build_info`
- `sourcenerve_process_uptime_seconds`
- `sourcenerve_http_active_requests`
- `sourcenerve_readiness`
- `sourcenerve_http_requests_total{operation,result}`
- `sourcenerve_http_request_duration_seconds{operation}`
- `sourcenerve_operations_total{operation,result,provider,workspace}`
- `sourcenerve_operation_duration_seconds{operation,provider}`
- `sourcenerve_provider_calls_total{kind,provider,result}`
- `sourcenerve_task_transitions_total{phase,provider}`
- `sourcenerve_callback_deliveries_total{result}`
- `sourcenerve_coordination_leases_total{result}`

HTTP operations use a fixed vocabulary such as `index`, `graph`, `scip`, `semantic`, `architecture`, `context`, `task_lifecycle`, `callback`, `mcp`, and webhook categories. Raw URLs and repository paths are never metric label values.

`provider_calls_total` records bounded provider kinds such as GitLab repository-host calls. Callback outcomes distinguish `success`, `retry`, and `error`. Coordination uses `success` and `conflict` to expose acquisition and contention.

## OpenTelemetry tracing

Tracing is disabled by default. Enable OTLP/HTTP JSON export with:

```bash
export SOURCENERVE_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT='https://collector.example.com'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/json'
```

SourceNerve sends traces to `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces`. You may instead configure the exact traces URL:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT='https://collector.example.com/v1/traces'
```

Only `http/json` is supported in this milestone. A non-HTTPS collector is rejected except for literal loopback development/CI use:

```bash
export SOURCENERVE_OTEL_ALLOW_INSECURE_LOOPBACK=true
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
```

Optional collector headers use the standard environment variable:

```bash
export OTEL_EXPORTER_OTLP_HEADERS='api-key=<collector-secret>,tenant=production'
```

Headers are server-side only, bounded, and passed to `curl` through stdin rather than process arguments.

When tracing is enabled, HTTP responses include:

```text
x-sourcenerve-trace-id: <32 hex characters>
```

This ID can be used to correlate a client-visible request with exported traces.

### Trace data boundary

Request spans intentionally contain only low-cardinality operational attributes:

- `service.name=sourcenerve`
- `service.version`
- `sourcenerve.operation`
- `http.request.method`
- `sourcenerve.result_class`

SourceNerve does not put repository paths, source code, semantic query text, chunk text, task bodies, webhook bodies, callback payloads, provider credentials, bearer tokens, or OTLP headers into trace attributes.

OTLP request bodies are bounded to 512 KiB, written to restrictive temporary files on Unix, and removed after export. Export failure is logged as a sanitized warning and does not fail the application request.

## Suggested dashboard

A useful production dashboard can be built from these panels:

| Panel | Example PromQL |
|---|---|
| Request rate | `sum(rate(sourcenerve_http_requests_total[5m])) by (operation)` |
| Error ratio | `sum(rate(sourcenerve_http_requests_total{result="error"}[5m])) / sum(rate(sourcenerve_http_requests_total[5m]))` |
| P95 request latency | `histogram_quantile(0.95, sum(rate(sourcenerve_http_request_duration_seconds_bucket[5m])) by (le,operation))` |
| Index / semantic / architecture latency | `histogram_quantile(0.95, sum(rate(sourcenerve_http_request_duration_seconds_bucket{operation=~"index|semantic|architecture|scip|graph"}[5m])) by (le,operation))` |
| Provider call errors | `sum(rate(sourcenerve_provider_calls_total{result="error"}[5m])) by (kind,provider)` |
| Task lifecycle transitions | `sum(rate(sourcenerve_task_transitions_total[15m])) by (phase,provider)` |
| Callback retries and failures | `sum(rate(sourcenerve_callback_deliveries_total{result=~"retry|error"}[5m])) by (result)` |
| Coordination contention | `sum(rate(sourcenerve_coordination_leases_total{result="conflict"}[5m]))` |
| Readiness | `sourcenerve_readiness` |
| Active requests | `sourcenerve_http_active_requests` |

## Alert guidance

Suggested starting alerts should be tuned to actual traffic before paging:

1. **Not ready:** `sourcenerve_readiness == 0` for 5 minutes after startup.
2. **High server error ratio:** 5xx-class `result="error"` exceeds 5% of requests for 10 minutes with meaningful request volume.
3. **Latency regression:** p95 latency for `index`, `semantic`, `architecture`, or `task_lifecycle` exceeds the established service SLO for 10 minutes.
4. **Provider failures:** sustained `sourcenerve_provider_calls_total{result="error"}` for a configured provider.
5. **Callback degradation:** callback `retry` or `error` rate stays above the normal baseline for 10 minutes.
6. **Coordination contention:** `coordination_leases_total{result="conflict"}` rises materially relative to successful acquisitions.
7. **Scrape missing:** Prometheus target is absent for more than two scrape intervals.
8. **OTLP exporter warnings:** alert from log aggregation only when sanitized exporter failures are sustained; one collector outage must not fail SourceNerve requests.

## Cardinality and privacy rules

Do not add these values as metric labels or trace attributes in future changes:

- file or repository paths;
- symbols when the symbol set is unbounded;
- source or diff content;
- semantic query/chunk text;
- task IDs, job IDs, callback delivery IDs, GitHub delivery IDs, PR numbers, issue numbers, commit SHAs, trace IDs;
- raw error strings or provider response bodies;
- user-controlled URLs;
- tokens, secrets, credentials, request headers, webhook signatures.

Prefer a fixed enum-like category and map unknown values to `other`. Workspace labels remain opt-in because repository fleets may make them high cardinality.

## Operational notes

- Metrics are process-local counters and histograms. Restart resets them; use Prometheus for durable time-series history.
- Readiness is updated when `/api/v1/readiness` is probed.
- OTLP export is asynchronous and best-effort. Collector failure must not become an application availability dependency.
- Metrics and tracing do not alter SQLite schema and do not persist request payloads.
- The observability milestone does not add a hosted Grafana/Prometheus/collector stack; it provides stable SourceNerve instrumentation and operating guidance for standard infrastructure.