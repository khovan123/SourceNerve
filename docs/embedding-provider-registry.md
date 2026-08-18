# Embedding provider registry

SourceNerve supports a server-side registry for managed semantic embedding providers. The existing OpenAI embedding integration remains backward compatible as provider id `openai`; additional providers are operator-configured and are never supplied as executable paths, URLs, arguments, or credentials by clients.

## Configuration

The legacy OpenAI environment variables remain unchanged:

```bash
export SOURCENERVE_OPENAI_API_KEY='<server-side key>'
export SOURCENERVE_OPENAI_EMBEDDING_MODEL='text-embedding-3-small' # optional
```

Additional providers are configured with `SOURCENERVE_EMBEDDING_PROVIDERS_JSON`. The first secondary backend is a fixed executable contract:

```bash
export SOURCENERVE_EMBEDDING_PROVIDERS_JSON='[
  {
    "id":"local-a",
    "kind":"executable",
    "model":"fixture-3",
    "executable":"/usr/local/bin/embed",
    "args":["--json"]
  }
]'
```

When more than one non-OpenAI provider is configured, set an explicit default:

```bash
export SOURCENERVE_EMBEDDING_DEFAULT_PROVIDER='local-a'
```

If OpenAI is configured and no default override is supplied, `openai` remains the default. If exactly one non-OpenAI provider is configured and OpenAI is disabled, that provider becomes the default.

Provider IDs and model IDs are bounded validated identifiers. The registry accepts at most eight secondary provider entries. Executable paths must be absolute and arguments are bounded printable ASCII strings.

## Executable provider contract

SourceNerve launches the operator-configured executable directly without shell interpolation. The process receives one bounded JSON request on stdin:

```json
{
  "model":"fixture-3",
  "input":["first chunk","second chunk"]
}
```

It must return bounded JSON on stdout using indexed embedding results:

```json
{
  "data":[
    {"index":0,"embedding":[1.0,0.0,0.0]},
    {"index":1,"embedding":[0.0,1.0,0.0]}
  ]
}
```

SourceNerve normalizes out-of-order indexes and rejects duplicate, missing, out-of-range, non-finite, zero-norm, inconsistent-dimension, or oversized vectors. Provider stderr is not surfaced to clients. Execution has a fixed timeout and bounded output. The child environment is cleared except for a minimal fixed runtime environment.

This executable is an operator-controlled integration seam, not arbitrary shell execution. Clients cannot choose the executable, arguments, environment, URL, or credentials.

## REST and MCP selection

Existing endpoints and MCP tool names are preserved. Managed index and text-search requests accept an optional `provider_id`:

```json
{
  "workspace":"example",
  "client_run_id":"semantic-2026-08-18-local-a",
  "max_chunks":128,
  "provider_id":"local-a"
}
```

```json
{
  "workspace":"example",
  "query":"billing reconciliation",
  "limit":20,
  "provider_id":"local-a"
}
```

If `provider_id` is omitted, the operator-selected default provider is used. Unknown or unconfigured provider IDs fail closed.

The authenticated REST route below returns only sanitized registry metadata:

```text
POST /api/v1/semantic/providers/status
```

It exposes provider id, model, backend kind, and default selection. It never returns executable paths, arguments, API keys, headers, provider request bodies, or credentials.

## Semantic provenance and replay

The existing `semantic_runs.provider` and `semantic_runs.model` fields remain authoritative provenance. Managed replay checks happen before provider execution and require the same provider, model, Git HEAD, graph version, and deterministic chunk plan.

An identical replay returns the existing run without a provider call. Reusing a `client_run_id` with a different provider or model fails closed.

After provider execution, SourceNerve still activates vectors through the existing semantic import transaction. Current Git HEAD, graph version, file hashes, line ranges, dimensions, and vector validity are rechecked before activation.

## Context packs

`provider_semantic: true` does not require a provider selector. SourceNerve resolves the provider and model from the current active semantic run and requires that matching provider to still be configured. This prevents a context request from silently embedding its query with a different model/provider than the active run.

Default context behavior remains local and unchanged when `provider_semantic` is omitted or false.

## Security and privacy boundary

- Provider credentials and executable configuration are server-side only and are not persisted in semantic state.
- No provider URL, executable path, arguments, or credentials are accepted from clients.
- No shell is used to interpolate provider commands.
- Query text is not persisted by managed text search or provider-semantic context.
- Source leaves SourceNerve only through an explicitly requested managed indexing operation.
- Provider error bodies and stderr are not exposed.
- External vector import remains available and unchanged.

## Non-goals

This registry does not provide OpenAI Responses, Chat Completions, autonomous planning, arbitrary shell execution, automatic patch generation, automatic merge, or a client-configurable OpenAI-compatible proxy.