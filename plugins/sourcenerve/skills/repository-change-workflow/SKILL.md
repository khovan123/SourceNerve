---
name: repository-change-workflow
description: Inspect and change a SourceNerve workspace using the shortest safe local workflow by default, with durable tasks available for restart-safe automation. Use for repository changes; do not commit or push unless the user explicitly requests it.
---

# Repository change workflow

Use SourceNerve MCP intelligence, installed MCP extensions, and plugin skills for context. For normal interactive coding, work directly against the configured local working tree. Do not create a durable task just to edit local source.

## Read-only requests

Start with `workspace_list` and `repo_snapshot`, then use `search_code`, `read_file`, `context_pack`, graph tools, or installed MCP/plugin tools as useful. A stale graph or dirty working tree does not block raw `search_code` and `read_file`.

## Interactive local change flow — default

Use this short flow unless the user explicitly needs a durable/restart-safe workflow:

1. Inspect the current workspace with `repo_snapshot`. A dirty tree is allowed; never reset, stash, discard, or overwrite unrelated user changes.
2. Gather only the context needed with `search_code`, `read_file`, graph/context tools, MCP extensions, and plugin skills.
3. Use `patch_preview` when useful, then `patch_apply` to update the local working tree. `patch_apply` is allowed on a dirty tree and uses current HEAD plus per-file SHA-256 expectations as concurrency checks. It does not require a task, feature branch, coordination lease, or current index.
4. Use `git_diff` / `git_review` to inspect the resulting local delta when useful.
5. Run builds, tests, linters, migrations, or bounded project commands with `workspace_exec` when needed. The command runs inside the configured workspace with a sanitized environment and bounded timeout/output.
6. Stop after applying/testing unless the user explicitly asks for Git persistence or remote actions.

Do **not** call `git_commit`, run `git commit`, call `git_push`, run `git push`, create a pull request, or merge merely because an edit succeeded. Those are separate user-controlled actions.

If the user explicitly asks to commit, review the current diff first and commit only the intended changes. If the user explicitly asks to commit and push, commit first and push only after the commit succeeds. Never force push.

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

The stronger task snapshot, coordination, clean-tree, and graph-version guards belong to this durable automation path; they are not prerequisites for ordinary interactive local editing.

## Safety rules

- Keep every read/write/command scoped to a configured workspace.
- Respect per-file SHA-256 expectations before applying a patch so a concurrently changed target file is not overwritten.
- A pre-existing dirty tree is valid local state; preserve it and include it when reasoning about diffs.
- Never automatically reset, checkout away, stash, clean, commit, push, open a PR, or merge.
- Prefer raw working-tree reads/search when repository intelligence is stale; index refresh failures must not block local editing or testing.
- `workspace_exec` may run shell-capable programs when needed, but keep commands bounded to the user’s repository task and do not use it to inspect host secrets or paths outside the workspace.
- Keep GitHub/GitLab credentials and provider OAuth server-side.
