---
name: repository-change-workflow
description: Inspect and change a SourceNerve workspace using the shortest safe local workflow by default, with durable tasks available for restart-safe automation. Use for repository changes; do not commit or push unless the user explicitly requests it.
---

# Repository change workflow

Use SourceNerve MCP intelligence, installed MCP extensions, and plugin skills for context. For normal interactive coding, work directly against the configured local working tree. Do not create a durable task just to edit local source.

For code writing, debugging, review, or refactoring, apply the bundled `karpathy-guidelines` skill as the default coding behavior alongside this workflow. SourceNerve Harness policy, repository guidance, approval boundaries, and explicit user instructions always take precedence.

## Read-only requests

Start with `workspace_list` and `repo_snapshot`, then use `search_code`, `read_file`, `workspace_file_fetch`, `context_pack`, graph tools, or installed MCP/plugin tools as useful. A stale graph or dirty working tree does not block raw `search_code`, `read_file`, or `workspace_file_fetch`. Use `workspace_file_fetch` when the exact whole file or binary-safe base64 transfer is needed; its result includes the SHA-256 for a safe follow-up put/delete.

## Interactive local change flow — default

Use this short flow unless the user explicitly needs a durable/restart-safe workflow:

1. Inspect the current workspace with `repo_snapshot`. A dirty tree is allowed; never reset, stash, discard, or overwrite unrelated user changes.
2. Gather only the context needed with `search_code`, `read_file`, `workspace_file_fetch`, graph/context tools, MCP extensions, and plugin skills.
3. Fetch/read the exact target before replacing or deleting it. For arbitrary text or binary transfer, use `workspace_file_put` with `encoding: utf8` or `encoding: base64` and the exact current SHA-256. Use `expected_sha256: null` only to create a file that must not already exist. `workspace_file_write` remains the UTF-8 convenience path. Use `workspace_file_delete` with the exact current SHA-256 for deletion. These operations edit the local working tree directly and do not require a task, clean tree, feature branch, coordination lease, patch parser, or current index.
4. Use `patch_preview` / `patch_apply` only when a unified multi-file or rename patch is genuinely more convenient. Direct patching is also allowed on a dirty tree and does not require a task, feature branch, coordination lease, or current index.
5. Use `git_diff` / `git_review` to inspect the resulting local delta when useful.
6. Run builds, tests, linters, migrations, application commands, or bounded terminal commands with `workspace_exec` when needed. The command runs from the configured workspace with a sanitized environment and bounded timeout/output.
7. Stop after applying/testing unless the user explicitly asks for Git persistence or remote actions.

Do **not** commit, push, create a pull request, or merge merely because an edit succeeded. Those are separate user-controlled actions.

For normal interactive work, when the user explicitly asks to commit, first inspect the current diff and then use `workspace_exec` to invoke the Git CLI for the intended commit. When the user explicitly asks to push or commit-and-push, use `workspace_exec` to invoke the Git CLI and push only after the intended commit succeeds. Never force push unless the user explicitly requests it and the repository policy permits it. Do not silently include unrelated pre-existing dirty files in a commit.

## Durable task flow — opt-in

Use the durable task lifecycle for webhook jobs, unattended/restart-safe automation, or when the user explicitly asks for the guarded durable workflow:

1. `task_begin`
2. `task_branch_checkout`
3. context/search/read
4. `task_propose_patch`
5. `task_apply_patch`
6. `task_git_review`
7. `task_git_commit` only when Git persistence is part of the requested durable workflow
8. `task_git_push` only when remote push is requested
9. provider issue/PR/merge tools only when requested and permitted
10. `task_default_sync` after a requested merge

The stronger task snapshot, coordination, worktree-drift, and graph-version guards belong to this durable automation path. `task_begin` may snapshot a pre-existing dirty tree, but later worktree drift still fails closed; protected branch/commit/push steps keep their own Git safety guards.

## Safety rules

- Keep every read/write/command scoped to a configured workspace.
- Respect exact per-file SHA-256 expectations before direct file replacement/deletion or patch application so a concurrently changed target file is not overwritten.
- Use `workspace_file_fetch`/`workspace_file_put` for binary-safe transfer instead of coercing arbitrary bytes through UTF-8.
- A pre-existing dirty tree is valid local state; preserve it and include it when reasoning about diffs.
- Never automatically reset, checkout away, stash, clean, commit, push, open a PR, or merge.
- Prefer raw working-tree reads/search when repository intelligence is stale; index refresh failures must not block local editing or testing.
- `workspace_exec` may run shell-capable programs when needed, but keep commands bounded to the user’s repository task and do not use it to inspect host secrets or unrelated paths.
- Keep GitHub/GitLab credentials and provider OAuth server-side.
