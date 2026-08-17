use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GitHubIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GitHubPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub head_sha: String,
    pub head_ref: String,
    pub base_ref: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GitHubMergeResult {
    pub merged: bool,
    pub sha: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct IssueApiResponse {
    number: u64,
    title: String,
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct PullRef {
    #[serde(default)]
    sha: String,
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Debug, Deserialize)]
struct PullApiResponse {
    number: u64,
    title: String,
    html_url: String,
    state: String,
    #[serde(default)]
    draft: bool,
    head: PullRef,
    base: PullRef,
}

#[derive(Debug, Deserialize)]
struct MergeApiResponse {
    merged: bool,
    sha: Option<String>,
    message: String,
}

fn command_error(stderr: &[u8]) -> AppError {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    AppError::Command(if detail.is_empty() {
        "GitHub CLI request failed".into()
    } else {
        format!("GitHub CLI request failed: {detail}")
    })
}

async fn gh_json(token: &str, args: &[String]) -> AppResult<String> {
    let output = Command::new("gh")
        .env("GH_TOKEN", token)
        .env_remove("GITHUB_TOKEN")
        .args(args)
        .output()
        .await
        .map_err(|error| AppError::Command(format!("failed to execute GitHub CLI: {error}")))?;
    if !output.status.success() {
        return Err(command_error(&output.stderr));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| AppError::Command("GitHub CLI returned non-UTF-8 output".into()))
}

pub fn repository_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/');
    let path = if let Some(rest) = remote.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = remote.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = remote.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = remote.strip_prefix("http://github.com/") {
        rest
    } else {
        return None;
    };
    let slug = path.trim_end_matches(".git");
    let mut parts = slug.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

pub async fn repository_for_workspace(
    root: &Path,
    remote_name: &str,
    configured_repository: Option<&str>,
) -> AppResult<String> {
    if let Some(repository) = configured_repository {
        let mut parts = repository.split('/');
        let valid = matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(repo), None) if !owner.is_empty() && !repo.is_empty());
        if !valid {
            return Err(AppError::InvalidRequest(
                "workspace github_repository must use owner/repo form".into(),
            ));
        }
        return Ok(repository.to_string());
    }
    let remote = crate::git::remote_url(root, remote_name).await?;
    repository_from_remote(&remote).ok_or_else(|| {
        AppError::InvalidRequest(
            "cannot infer a github.com owner/repo from the configured Git remote; set workspace.github_repository explicitly"
                .into(),
        )
    })
}

pub async fn create_issue(
    token: &str,
    repository: &str,
    title: &str,
    body: &str,
) -> AppResult<GitHubIssue> {
    let endpoint = format!("repos/{repository}/issues");
    let output = gh_json(
        token,
        &[
            "api".into(),
            "--method".into(),
            "POST".into(),
            endpoint,
            "--raw-field".into(),
            format!("title={title}"),
            "--raw-field".into(),
            format!("body={body}"),
        ],
    )
    .await?;
    let response: IssueApiResponse = serde_json::from_str(&output)
        .map_err(|error| AppError::Command(format!("invalid GitHub issue response: {error}")))?;
    Ok(GitHubIssue {
        number: response.number,
        title: response.title,
        url: response.html_url,
    })
}

pub async fn create_pull_request(
    token: &str,
    repository: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    draft: bool,
) -> AppResult<GitHubPullRequest> {
    let endpoint = format!("repos/{repository}/pulls");
    let mut args = vec![
        "api".into(),
        "--method".into(),
        "POST".into(),
        endpoint,
        "--raw-field".into(),
        format!("title={title}"),
        "--raw-field".into(),
        format!("body={body}"),
        "--raw-field".into(),
        format!("head={head}"),
        "--raw-field".into(),
        format!("base={base}"),
    ];
    if draft {
        args.extend(["--field".into(), "draft=true".into()]);
    }
    let output = gh_json(token, &args).await?;
    parse_pull(&output)
}

pub async fn get_pull_request(
    token: &str,
    repository: &str,
    number: u64,
) -> AppResult<GitHubPullRequest> {
    let output = gh_json(
        token,
        &["api".into(), format!("repos/{repository}/pulls/{number}")],
    )
    .await?;
    parse_pull(&output)
}

fn parse_pull(output: &str) -> AppResult<GitHubPullRequest> {
    let response: PullApiResponse = serde_json::from_str(output)
        .map_err(|error| AppError::Command(format!("invalid GitHub pull response: {error}")))?;
    Ok(GitHubPullRequest {
        number: response.number,
        title: response.title,
        url: response.html_url,
        state: response.state,
        draft: response.draft,
        head_sha: response.head.sha,
        head_ref: response.head.ref_name,
        base_ref: response.base.ref_name,
    })
}

pub async fn merge_pull_request(
    token: &str,
    repository: &str,
    number: u64,
    expected_head_sha: &str,
    merge_method: &str,
) -> AppResult<GitHubMergeResult> {
    let current = get_pull_request(token, repository, number).await?;
    if current.state != "open" {
        return Err(AppError::InvalidRequest(format!(
            "pull request #{number} is not open"
        )));
    }
    if current.draft {
        return Err(AppError::InvalidRequest(format!(
            "pull request #{number} is still a draft"
        )));
    }
    if current.head_sha != expected_head_sha {
        return Err(AppError::WorkspaceChanged {
            expected: expected_head_sha.to_string(),
            actual: current.head_sha,
        });
    }
    if !matches!(merge_method, "merge" | "squash" | "rebase") {
        return Err(AppError::InvalidRequest(
            "merge_method must be merge, squash, or rebase".into(),
        ));
    }

    let output = gh_json(
        token,
        &[
            "api".into(),
            "--method".into(),
            "PUT".into(),
            format!("repos/{repository}/pulls/{number}/merge"),
            "--raw-field".into(),
            format!("sha={expected_head_sha}"),
            "--raw-field".into(),
            format!("merge_method={merge_method}"),
        ],
    )
    .await?;
    let response: MergeApiResponse = serde_json::from_str(&output)
        .map_err(|error| AppError::Command(format!("invalid GitHub merge response: {error}")))?;
    Ok(GitHubMergeResult {
        merged: response.merged,
        sha: response.sha,
        message: response.message,
    })
}

#[cfg(test)]
mod tests {
    use super::repository_from_remote;

    #[test]
    fn parses_supported_github_remotes() {
        for remote in [
            "git@github.com:Fogewise-Tech/SourceNerve.git",
            "ssh://git@github.com/Fogewise-Tech/SourceNerve.git",
            "https://github.com/Fogewise-Tech/SourceNerve.git",
            "https://github.com/Fogewise-Tech/SourceNerve",
        ] {
            assert_eq!(
                repository_from_remote(remote).as_deref(),
                Some("Fogewise-Tech/SourceNerve")
            );
        }
    }

    #[test]
    fn rejects_non_github_or_nested_remotes() {
        assert!(repository_from_remote("git@gitlab.com:a/b.git").is_none());
        assert!(repository_from_remote("https://github.com/a/b/c.git").is_none());
    }
}
