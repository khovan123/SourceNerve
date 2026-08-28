---
name: karpathy-guidelines
description: Default coding behavior for SourceNerve-backed ChatGPT and Codex sessions. Use when writing, reviewing, debugging, or refactoring code to surface assumptions, keep solutions simple, make surgical changes, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Apply these guidelines by default for coding work performed through SourceNerve. They supplement the SourceNerve Harness, repository guidance, user instructions, approval policy, and safety boundaries; they never override them.

These guidelines are adapted from the `multica-ai/andrej-karpathy-skills` project and bias toward caution over speed. For trivial tasks, use judgment while preserving the same principles.

## 1. Think Before Coding

Do not silently guess or hide uncertainty.

Before implementing:

- State assumptions when they materially affect the implementation.
- If multiple reasonable interpretations exist, surface them instead of silently choosing one.
- Prefer a simpler approach when it satisfies the requested outcome.
- If a critical ambiguity prevents a safe implementation, identify it before mutating code.

## 2. Simplicity First

Write the minimum code that solves the current request.

- Do not add speculative features.
- Do not introduce abstractions for a single use without a concrete need.
- Do not add configurability that was not requested.
- Avoid defensive handling for impossible states unless repository evidence shows it is needed.
- If the implementation is substantially larger than the problem requires, simplify it.

Ask: would a senior engineer consider this overcomplicated? If yes, reduce it.

## 3. Surgical Changes

Touch only what the task requires and preserve surrounding behavior.

When editing existing code:

- Do not refactor unrelated code, comments, formatting, or APIs.
- Match the repository's existing conventions unless the task explicitly changes them.
- If unrelated dead code is discovered, mention it rather than deleting it.
- Remove imports, variables, helpers, or files only when your own change made them unused.
- Preserve pre-existing dirty worktree changes that are unrelated to the request.

Every changed line should be traceable to the requested outcome or to the proof needed to verify it.

## 4. Goal-Driven Execution

Translate the request into a checkable result and verify it before declaring completion.

Examples:

- Add validation → demonstrate invalid inputs are rejected and valid inputs still work.
- Fix a bug → reproduce the failure, implement the smallest fix, then prove the regression is resolved.
- Refactor behavior-preserving code → establish relevant proof before and after the change.

For multi-step work, keep the plan brief and attach a concrete verification step to each meaningful change. Prefer the proof selected by the SourceNerve Harness from repository-owned validation surfaces rather than treating any command containing `test`, `build`, or `lint` as sufficient.

## SourceNerve precedence

When this skill conflicts with a SourceNerve Harness rule, repository `AGENTS.md`/project guidance, explicit user instruction, approval boundary, or safety policy, follow the higher-authority SourceNerve/user rule. In particular, this skill never grants permission to commit, push, open or merge a pull request, widen sandbox access, or bypass verification.

## Attribution

Adapted from `https://github.com/multica-ai/andrej-karpathy-skills`, skill `skills/karpathy-guidelines/SKILL.md`, licensed MIT. The upstream project attributes the behavioral principles to Andrej Karpathy's public observations on common LLM coding pitfalls.
