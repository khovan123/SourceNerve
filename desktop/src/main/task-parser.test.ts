import { describe, expect, it } from "vitest";

import {
  parseTaskApplyResult,
  parseTaskBegin,
  parseTaskCommitResult,
  parseTaskPushResult,
  parseTaskReviewResult,
  parseTaskSnapshot,
} from "./task-parser";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROPOSAL_ID = "123e4567-e89b-42d3-a456-426614174001";
const CHANGESET_ID = "123e4567-e89b-42d3-a456-426614174002";
const HEAD = "a".repeat(40);
const COMMIT = "b".repeat(40);
const SHA256 = "c".repeat(64);

const task = {
  id: TASK_ID,
  workspace: "api",
  client_request_id: null,
  base_head: HEAD,
  graph_version: 7,
  status: "active",
  context_query: "auth flow",
  context_sha256: SHA256,
  stale_reason: null,
  created_at: 1,
  updated_at: 2,
};

const lifecycle = {
  task_id: TASK_ID,
  phase: "branched",
  branch: "feat/task-123",
  reviewed_diff_sha256: null,
  commit_sha: null,
  push_sha: null,
  issue_number: null,
  pull_number: null,
  pull_head_sha: null,
  merge_sha: null,
  default_synced_head: null,
  updated_at: 2,
  provider: null,
};

describe("guarded task response parsers", () => {
  it("parses durable task snapshot while dropping sensitive event metadata", () => {
    const snapshot = parseTaskSnapshot({
      task,
      proposals: [{
        id: PROPOSAL_ID,
        task_id: TASK_ID,
        idempotency_key: "ignored",
        expected_head: HEAD,
        patch_sha256: SHA256,
        changed_paths: ["src/http.rs"],
        status: "proposed",
        changeset_id: null,
        created_at: 2,
        applied_at: null,
      }],
      events: [{
        id: 1,
        event_type: "proposal_created",
        metadata: {
          safe: "kept",
          patch: "raw patch must disappear",
          token: "secret-token",
          nested: { authorization: "Bearer secret", reason: "kept" },
        },
        created_at: 2,
      }],
      lifecycle,
      github_observation: { raw_provider_state: "not part of #69" },
    });

    expect(snapshot.task.baseHead).toBe(HEAD);
    expect(snapshot.proposals[0]?.patchSha256).toBe(SHA256);
    expect(snapshot.events[0]?.metadata).toEqual({ safe: "kept", nested: { reason: "kept" } });
    expect(JSON.stringify(snapshot)).not.toContain("raw patch must disappear");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("raw_provider_state");
  });

  it("parses task begin with bounded context-pack data", () => {
    const begun = parseTaskBegin({
      task,
      replayed: false,
      context: {
        workspace: "api",
        query: "auth flow",
        head: HEAD,
        indexed_head: HEAD,
        graph_version: 7,
        clean: true,
        consistency: "current",
        max_bytes: 65536,
        max_items: 20,
        used_bytes: 12,
        truncated: false,
        items: [],
      },
    });
    expect(begun.context?.usedBytes).toBe(12);
    expect(begun.replayed).toBe(false);
  });

  it("parses applied and reviewed diffs with exact SHA gates", () => {
    const applied = parseTaskApplyResult({
      task_id: TASK_ID,
      proposal_id: PROPOSAL_ID,
      changeset_id: CHANGESET_ID,
      head: HEAD,
      changed_paths: ["src/http.rs"],
      diff: "diff --git a/src/http.rs b/src/http.rs\n",
    });
    expect(applied.changedPaths).toEqual(["src/http.rs"]);

    const reviewed = parseTaskReviewResult({
      lifecycle: { ...lifecycle, phase: "reviewed", reviewed_diff_sha256: SHA256 },
      review: {
        workspace: "api",
        branch: "feat/task-123",
        head: HEAD,
        dirty: true,
        status: " M src/http.rs",
        diff: "diff --git a/src/http.rs b/src/http.rs\n",
        diff_sha256: SHA256,
      },
      replayed: false,
    });
    expect(reviewed.review.diffSha256).toBe(SHA256);
    expect(reviewed.lifecycle.reviewedDiffSha256).toBe(SHA256);
  });

  it("parses exact commit and push lifecycle state", () => {
    const committed = parseTaskCommitResult({
      lifecycle: { ...lifecycle, phase: "committed", reviewed_diff_sha256: SHA256, commit_sha: COMMIT },
      commit: {
        workspace: "api",
        branch: "feat/task-123",
        parent_head: HEAD,
        commit: COMMIT,
        clean: true,
        status: "",
      },
      replayed: false,
    });
    expect(committed.commit.commit).toBe(COMMIT);

    const pushed = parseTaskPushResult({
      lifecycle: { ...lifecycle, phase: "pushed", reviewed_diff_sha256: SHA256, commit_sha: COMMIT, push_sha: COMMIT },
      push: {
        workspace: "api",
        remote: "origin",
        branch: "feat/task-123",
        head: COMMIT,
      },
      replayed: false,
    });
    expect(pushed.push.head).toBe(COMMIT);
  });

  it("fails closed for unsafe paths and unknown lifecycle phases", () => {
    expect(() => parseTaskApplyResult({
      task_id: TASK_ID,
      proposal_id: PROPOSAL_ID,
      changeset_id: CHANGESET_ID,
      head: HEAD,
      changed_paths: ["../secret"],
      diff: "x",
    })).toThrow(/unsafe/);

    expect(() => parseTaskSnapshot({
      task,
      proposals: [],
      events: [],
      lifecycle: { ...lifecycle, phase: "force-pushed" },
    })).toThrow(/phase/);
  });
});
