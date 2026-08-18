# Managed SCIP analyzers

SourceNerve can run a bounded, operator-configured SCIP analyzer and activate its output through the existing SCIP enrichment importer. The feature is additive: Tree-sitter graph state remains authoritative and analyzer failure never replaces deterministic graph facts.

## Configuration

Managed analyzers are configured only at process startup through `SOURCENERVE_SCIP_ANALYZERS_JSON`. Clients cannot register an executable, command, argument list, environment variable, or arbitrary provider URL.

Example:

```json
[
  {
    "id": "rust-scip",
    "executable": "/usr/local/bin/scip-rust",
    "args": ["--output", "{output}"],
    "manifests": ["Cargo.toml"],
    "timeout_seconds": 60,
    "max_output_bytes": 33554432
  }
]
```

The executable must be an absolute path to a regular executable file. Arguments are fixed by the operator and may use only the `{output}` placeholder. At least one argument must contain `{output}`. Manifest entries are simple file names used to discover eligible project roots.

Startup fails closed for an invalid registry. The runtime supports at most 16 analyzers, 32 arguments per analyzer, 16 manifest names, a timeout of at most 300 seconds, and analyzer output no larger than the existing 32 MiB SCIP import bound.

## Project-root discovery

SourceNerve scans only below the configured workspace root and returns relative eligible project roots. Discovery is bounded by depth, entry count, and result count, and skips common generated/vendor directories such as `.git`, `node_modules`, `target`, `vendor`, and `.venv`.

If one analyzer has exactly one eligible project root, `project_root` may be omitted. If multiple roots are eligible, the client must select one exact value returned by analyzer status. Absolute paths and parent-directory traversal are rejected.

## Execution boundary

Before execution SourceNerve requires:

- a clean Git working tree;
- current Git HEAD equal to the indexed HEAD;
- the current deterministic graph version;
- an analyzer ID present in the server-owned registry;
- a currently eligible project root.

The executable is SHA-256 fingerprinted for run provenance before it starts. The analyzer process is spawned directly without a shell. SourceNerve clears the inherited environment and sets only a small fixed environment (`PATH`, temporary `HOME`, temporary `TMPDIR`, `GIT_TERMINAL_PROMPT=0`, and `CI=1`). Standard input, output, and error are not inherited.

Analyzer execution is bounded by a process-wide concurrency gate, timeout, output type, and output size. The generated file must be a non-empty regular file. Temporary analyzer output is removed after the request.

## Activation and consistency

Analyzer bytes are never activated directly. A successful process result is passed to the existing official SCIP protobuf importer with the pre-execution Git HEAD and graph version. That importer repeats the clean-tree, HEAD, indexed-HEAD, and graph-version checks before commit.

If source or graph state changes while the analyzer is running, activation is rejected. A failed, timed-out, oversized, invalid, or stale analyzer run does not stale or replace the previous active SCIP enrichment.

The successful SCIP run remains bound to the exact Git HEAD and graph version. Existing SCIP status logic invalidates enrichment when those facts are no longer current.

## Durable analyzer runs

Schema v15 adds `scip_analyzer_runs`. SourceNerve persists only bounded operational provenance:

- analyzer ID;
- relative project root;
- Git HEAD and graph version;
- executable SHA-256;
- sanitized status/failure code;
- linked SCIP run ID and SCIP provider metadata;
- SCIP index SHA-256;
- timestamps.

Executable paths, command arguments, stdout/stderr, environment variables, source text, and generated SCIP bytes are not stored in analyzer-run state.

An interrupted prior `running` row for the same workspace/analyzer is marked failed when a new run starts. Analyzer history therefore survives process restart without claiming an abandoned process is still active.

## REST

All routes are authenticated through the normal SourceNerve bearer-token layer.

Analyzer registry/status:

```http
POST /api/v1/graph/scip/analyzers/status
Content-Type: application/json

{"workspace":"repo"}
```

Run a configured analyzer:

```http
POST /api/v1/graph/scip/analyze
Content-Type: application/json

{
  "workspace":"repo",
  "analyzer_id":"rust-scip",
  "project_root":"."
}
```

The status response intentionally omits executable paths and argument lists.

Existing manual SCIP surfaces remain available:

- `POST /api/v1/graph/scip/status`
- `POST /api/v1/graph/scip/import`

## MCP

The MCP surface adds:

- `scip_analyzer_status`
- `scip_analyze`

The descriptions explicitly state that analyzers are server-owned and clients cannot supply executables or arguments.

## Failure behavior

Common analyzer failures are persisted only as sanitized codes such as `timeout`, `non_zero_exit`, `oversized_output`, `missing_output`, `invalid_output_type`, `activation_rejected`, or `analyzer_failed`. Raw process stderr is not returned or persisted.

When managed analyzers are not configured, the managed analyze route fails clearly. Manual SCIP import and all deterministic graph behavior remain available.

## Non-goals

This milestone does not provide:

- arbitrary client shell execution;
- client-provided analyzer binaries or command arguments;
- package installation or dependency resolution;
- automatic background analyzer refresh;
- LLM execution;
- replacement of Tree-sitter graph facts with analyzer output.
