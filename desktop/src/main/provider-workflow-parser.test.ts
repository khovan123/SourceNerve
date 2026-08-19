import { describe, expect, it } from "vitest";

import { parseProviderIssue, parseProviderPull } from "./provider-workflow-parser";

const HEAD = "a".repeat(40);

describe("provider workflow response parser", () => {
  it("parses GitHub pull state from bounded provider metadata", () => {
    const pull = parseProviderPull({
      pull: {
        number: 42,
        title: "feat: lifecycle",
        state: "open",
        draft: false,
        base_branch: "main",
        head_branch: "feat/task",
        head_sha: HEAD,
        mergeable: true,
        merge_state: "clean",
        html_url: "https://github.com/acme/repo/pull/42",
      },
    }, { provider: "github", repository: "acme/repo" });
    expect(pull).toMatchObject({ number: 42, state: "open", headSha: HEAD, baseBranch: "main" });
    expect(pull.url).toContain("github.com/acme/repo/pull/42");
  });

  it("parses GitLab merge request aliases", () => {
    const pull = parseProviderPull({
      merge_request: {
        iid: 7,
        title: "MR",
        state: "opened",
        work_in_progress: false,
        target_branch: "main",
        source_branch: "feat/task",
        sha: HEAD,
        detailed_merge_status: "mergeable",
        web_url: "https://gitlab.com/group/repo/-/merge_requests/7",
      },
    }, { provider: "gitlab", repository: "group/repo" });
    expect(pull.provider).toBe("gitlab");
    expect(pull.number).toBe(7);
    expect(pull.state).toBe("open");
  });

  it("rejects a provider URL on the wrong origin or repository", () => {
    expect(() => parseProviderPull({
      number: 1,
      state: "open",
      draft: false,
      base_branch: "main",
      head_branch: "feat/task",
      head_sha: HEAD,
      html_url: "https://evil.example/acme/repo/pull/1",
    }, { provider: "github", repository: "acme/repo" })).toThrow(/origin/);

    expect(() => parseProviderPull({
      number: 1,
      state: "open",
      draft: false,
      base_branch: "main",
      head_branch: "feat/task",
      head_sha: HEAD,
      html_url: "https://github.com/other/repo/pull/1",
    }, { provider: "github", repository: "acme/repo" })).toThrow(/repository/);
  });

  it("parses issue metadata but can safely fall back when create response is not shaped as an issue", () => {
    expect(parseProviderIssue({ ok: true }, { provider: "github", repository: "acme/repo", fallbackTitle: "Issue" })).toBeNull();
    const issue = parseProviderIssue({
      issue: {
        number: 9,
        title: "Issue",
        state: "open",
        html_url: "https://github.com/acme/repo/issues/9",
      },
    }, { provider: "github", repository: "acme/repo", fallbackTitle: "Fallback" });
    expect(issue?.number).toBe(9);
  });
});
