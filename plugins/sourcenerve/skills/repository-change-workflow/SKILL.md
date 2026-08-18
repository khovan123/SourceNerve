---
name: repository-change-workflow
description: Safely inspect a SourceNerve workspace and carry a requested code change through bounded context, guarded patching, reviewed Git commit/push, provider change request, and optional guarded merge. Use for end-to-end repository changes; do not use when the user only wants read-only analysis.
---

# Repository change workflow

Use the existing SourceNerve MCP tools. Do not create a parallel shell or Git workflow.

## Read-only requests

For analysis-only work, start with `workspace_list` and `repo_snapshot`, then use `context_pack`, graph tools, `search_code`, or `read_file` as needed. Stop before any mutation tool.

## Durable task flow

Prefer the durable task lifecycle when a requested change may span multiple turns or need restart-safe recovery:

1. `task_begin` to bind the task to the exact clean Git HEAD and graph version.
2. `task_branch_checkout` to create or recover the task feature branch.
3. Gather bounded repository context with `context_pack`, graph queries, search, and file reads.
4. `task_propose_patch` to validate and persist the proposal without changing source.
5. `task_apply_patch` only after the proposal is ready to apply.
6. `task_git_review` and inspect the complete reviewed delta before commit.
7. `task_git_commit`, then `task_git_push`.
8. Create the provider change request with `task_provider_pull_create`; create an issue first only when useful.
9. Use `task_provider_pull_get` to inspect the current provider state and exact head SHA.
10. Call `task_provider_pull_merge` only when the user explicitly asks to merge and provider checks/reviews permit it.
11. After merge, call `task_default_sync` to fast-forward the configured default branch and rebuild repository intelligence.

## Direct guarded flow

When a durable task is unnecessary, keep the same safety order:

`repo_snapshot` -> `git_branch_checkout` -> context/search/read -> `patch_preview` -> `patch_apply` -> `git_review` -> `git_commit` -> `git_push` -> provider pull request -> provider state check -> guarded merge -> `git_default_sync`.

## Non-negotiable guards

- Never bypass exact `expected_head` checks.
- Never bypass per-file SHA-256 expectations for patches.
- Never commit without the reviewed diff SHA still matching.
- Never commit directly on the configured default branch.
- Never force push, reset, or invent arbitrary Git refspecs.
- Never treat a green CI observation as permission to merge by itself.
- Never merge when the provider head moved from the reviewed/pushed SHA.
- Keep GitHub/GitLab and Git credentials server-side.
- If repository state becomes dirty or stale unexpectedly, stop and refresh the snapshot instead of silently rebasing generated work.
