# SourceNerve plugin tool review

This document summarizes the built-in MCP/Harness tool metadata after SourceNerve was reduced to a guarded Harness shell. Repository-intelligence tools are not implemented by the core; equivalent capabilities may be supplied independently by installed plugin skills or MCP extensions under SourceNerve policy.

Every public core tool must have explicit policy metadata. Unknown tools use the conservative fallback and are not silently treated as safe.

| Tool/group | readOnly | destructive | openWorld | Notes |
|---|---:|---:|---:|---|
| `service_status`, `readiness`, `workspace_list` | true | false | false | Sanitized runtime/workspace state. |
| `state_backup_validate`, `mutation_audit` | true | false | false | Reads validated local operational state. |
| `repo_snapshot`, `read_file`, `workspace_file_fetch`, `git_diff`, `git_review`, `patch_preview` | true | false | false | Exact local workspace/Git evidence only. |
| `plugin_catalog`, `plugin_skill_read` | true | false | false | Workspace-visible plugin skill discovery/read; skill text is untrusted instruction data. |
| `mcp_extension_catalog`, `mcp_extension_call_read` | true | false | false | Enabled extension discovery/read dispatch through the gateway. |
| `github_pull_get` | true | false | true | Reads external provider state. |
| `state_backup_create` | false | false | false | Persists a local operational backup. |
| `task_begin`, `task_propose_patch` | false | false | false | Persists durable task/proposal state without applying source. |
| `task_get`, `task_git_review` | false | false | false | May persist lifecycle/staleness/review observations. |
| `task_cancel`, `task_apply_patch` | false | true | false | Cancels/rejects pending work or applies guarded source mutation. |
| `task_branch_checkout`, `task_git_commit` | false | false | false | Guarded local Git lifecycle. |
| `task_git_push`, `task_default_sync` | false | false | true | Guarded remote Git lifecycle. |
| task provider issue/PR create/get | false | false | true | Provider state mutation/observation with restart-safe lifecycle state. |
| task provider merge | false | true | true | Explicit externally visible merge. |
| `git_branch_checkout`, `git_commit` | false | false | false | Direct guarded local Git lifecycle. |
| `git_push`, `git_default_sync` | false | false | true | Direct guarded remote Git lifecycle. |
| direct provider issue/PR create/get | varies | false | true | Provider operations use exact/bounded contracts. |
| direct provider merge | false | true | true | Explicit external merge. |
| `patch_apply` | false | true | false | Guarded local patch application. |
| `workspace_file_put`, `workspace_file_write`, `workspace_file_delete` | false | true | false | SHA-guarded direct workspace file mutation. |
| `workspace_exec` | false | true | true | Bounded sanitized execution; policy/approval controls apply. |
| `mcp_extension_call_write` | false | true | true | Extension mutation is routed through SourceNerve gateway policy. |

## Removed core intelligence tools

The core must not advertise or route built-in repository indexing, persistent code memory, graph/symbol traversal, semantic/vector retrieval, architecture analysis, context-pack generation, or SCIP analyzer/import tools. Plugin/MCP implementations may expose their own namespaced equivalents and are governed separately by workspace visibility and Harness policy.

## Review notes

- State backup tools remain operator-only for OAuth clients.
- Workspace authorization is evaluated independently from annotations.
- A tool that may persist lifecycle observations is not labeled read-only merely because its primary output is status.
- External provider and extension operations use `openWorldHint=true` where appropriate.
- Source mutation and provider merge operations are destructive.
- Green CI or provider state is never implicit permission to merge; merge still requires an explicit user request and the existing concurrency guards.
