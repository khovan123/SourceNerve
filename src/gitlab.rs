use std::{env, path::Path, path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const PROD_API_URL: &str = "https://gitlab.com/api/v4";
const MAX_BODY_BYTES: usize = 1_000_000;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 35;

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    token: String,
    api_url: String,
}

static RUNTIME: OnceLock<Option<RuntimeConfig>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct GitLabIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct GitLabMergeRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub head_sha: String,
    pub head_ref: String,
    pub base_ref: String,
    #[serde(default)]
    pub merged: bool,
    #[serde(default)]
    pub merge_commit_sha: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct GitLabMergeResult {
    pub merged: bool,
    pub sha: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct IssueApiResponse {
    iid: u64,
    title: String,
    web_url: String,
}

#[derive(Debug, Deserialize)]
struct MergeRequestApiResponse {
    iid: u64,
    title: String,
    web_url: String,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    sha: String,
    source_branch: String,
    target_branch: String,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    merge_commit_sha: Option<String>,
}

struct TempBody(PathBuf);

impl Drop for TempBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl RuntimeConfig {
    pub fn from_env() -> AppResult<Option<Self>> {
        let token = env::var("SOURCENERVE_GITLAB_TOKEN").ok();
        let api_override = env::var("SOURCENERVE_GITLAB_API_URL").ok();
        let allow_loopback = env_bool("SOURCENERVE_GITLAB_ALLOW_INSECURE_LOOPBACK")?;

        if token.is_none() && api_override.is_none() && !allow_loopback {
            return Ok(None);
        }
        let token = token.ok_or_else(|| {
            AppError::InvalidRequest(
                "SOURCENERVE_GITLAB_TOKEN is required when GitLab lifecycle is configured".into(),
            )
        })?;
        if token.trim().len() < 20 || token.len() > 512 || !token.is_ascii() {
            return Err(AppError::InvalidRequest(
                "SOURCENERVE_GITLAB_TOKEN must be 20-512 ASCII bytes".into(),
            ));
        }

        let api_url = match api_override {
            None => PROD_API_URL.to_string(),
            Some(value) => {
                if !allow_loopback || !valid_loopback_api_url(&value) {
                    return Err(AppError::InvalidRequest(
                        "SOURCENERVE_GITLAB_API_URL is allowed only for literal http://127.0.0.1 loopback when SOURCENERVE_GITLAB_ALLOW_INSECURE_LOOPBACK=true"
                            .into(),
                    ));
                }
                value.trim_end_matches('/').to_string()
            }
        };
        Ok(Some(Self { token, api_url }))
    }
}

pub async fn preflight(config: Option<&RuntimeConfig>) -> AppResult<()> {
    if config.is_none() {
        return Ok(());
    }
    let status = Command::new("curl")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| AppError::Command(format!("failed to execute curl: {error}")))?;
    if !status.success() {
        return Err(AppError::Command(
            "curl is required when GitLab lifecycle is configured".into(),
        ));
    }
    Ok(())
}

pub fn install_runtime(config: Option<RuntimeConfig>) -> AppResult<()> {
    RUNTIME
        .set(config)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("GitLab runtime already installed")))
}

fn runtime() -> AppResult<&'static RuntimeConfig> {
    RUNTIME
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "GitLab lifecycle is not configured; set SOURCENERVE_GITLAB_TOKEN".into(),
            )
        })
}

fn env_bool(name: &str) -> AppResult<bool> {
    let Ok(value) = env::var(name) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(AppError::InvalidRequest(format!(
            "{name} must be one of true/false, 1/0, yes/no, or on/off"
        ))),
    }
}

fn valid_loopback_api_url(value: &str) -> bool {
    if value.trim() != value
        || value.contains('@')
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
    {
        return false;
    }
    let Some(rest) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    !authority.is_empty() && authority.chars().all(|ch| ch.is_ascii_digit())
}

fn valid_repository(repository: &str) -> bool {
    let parts = repository.split('/').collect::<Vec<_>>();
    (2..=8).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 128
                && part.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')
                })
        })
}

pub fn repository_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/');
    let path = if let Some(rest) = remote.strip_prefix("git@gitlab.com:") {
        rest
    } else if let Some(rest) = remote.strip_prefix("ssh://git@gitlab.com/") {
        rest
    } else if let Some(rest) = remote.strip_prefix("https://gitlab.com/") {
        rest
    } else if let Some(rest) = remote.strip_prefix("http://gitlab.com/") {
        rest
    } else {
        return None;
    };
    let slug = path.trim_end_matches(".git");
    valid_repository(slug).then(|| slug.to_string())
}

pub async fn repository_for_workspace(
    root: &Path,
    remote_name: &str,
    configured_repository: Option<&str>,
) -> AppResult<String> {
    if let Some(repository) = configured_repository {
        if !valid_repository(repository) {
            return Err(AppError::InvalidRequest(
                "workspace repository for GitLab must use group/project or group/subgroup/project form"
                    .into(),
            ));
        }
        return Ok(repository.to_string());
    }
    let remote = crate::git::remote_url(root, remote_name).await?;
    repository_from_remote(&remote).ok_or_else(|| {
        AppError::InvalidRequest(
            "cannot infer a gitlab.com repository from the configured Git remote; set workspace.repository explicitly"
                .into(),
        )
    })
}

fn project_id(repository: &str) -> String {
    repository.replace('/', "%2F")
}

async fn write_body(value: &serde_json::Value) -> AppResult<TempBody> {
    let bytes = serde_json::to_vec(value).map_err(anyhow::Error::from)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(AppError::InvalidRequest(
            "GitLab provider request body exceeds 1 MB".into(),
        ));
    }
    let path = env::temp_dir().join(format!(
        ".sourcenerve-gitlab-request-{}.json",
        Uuid::new_v4()
    ));
    tokio::fs::write(&path, bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(TempBody(path))
}

async fn request(method: &str, path: &str, body: Option<&serde_json::Value>) -> AppResult<String> {
    let config = runtime()?;
    let url = format!("{}{}", config.api_url, path);
    let temp_body = match body {
        Some(value) => Some(write_body(value).await?),
        None => None,
    };

    let mut command = Command::new("curl");
    command
        .env_clear()
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .args([
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--connect-timeout",
            "5",
            "--max-time",
            "30",
            "--max-filesize",
            &MAX_RESPONSE_BYTES.to_string(),
            "--request",
            method,
            "--url",
            &url,
            "--header",
            "Content-Type: application/json",
            "--header",
            "@-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(body) = temp_body.as_ref() {
        command.arg("--data-binary").arg(format!("@{}", body.0.display()));
    }
    let mut child = command
        .spawn()
        .map_err(|error| AppError::Command(format!("failed to execute GitLab request: {error}")))?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("failed to open GitLab curl stdin"))
    })?;
    stdin
        .write_all(format!("PRIVATE-TOKEN: {}\n", config.token).as_bytes())
        .await?;
    drop(stdin);

    let output = timeout(
        Duration::from_secs(REQUEST_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| AppError::Command("GitLab request timed out".into()))?
    .map_err(|error| AppError::Command(format!("GitLab request failed: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Command(format!(
            "GitLab API request failed with curl status {}",
            output.status
        )));
    }
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err(AppError::Command(
            "GitLab API response exceeded 8 MiB limit".into(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| AppError::Command("GitLab API returned non-UTF-8 output".into()))
}

pub async fn create_issue(
    repository: &str,
    title: &str,
    body: &str,
) -> AppResult<GitLabIssue> {
    let response = request(
        "POST",
        &format!("/projects/{}/issues", project_id(repository)),
        Some(&serde_json::json!({ "title": title, "description": body })),
    )
    .await?;
    let value: IssueApiResponse = serde_json::from_str(&response)
        .map_err(|_| AppError::Command("invalid GitLab issue response".into()))?;
    Ok(GitLabIssue {
        number: value.iid,
        title: value.title,
        url: value.web_url,
    })
}

fn parse_merge_request(output: &str) -> AppResult<GitLabMergeRequest> {
    let value: MergeRequestApiResponse = serde_json::from_str(output)
        .map_err(|_| AppError::Command("invalid GitLab merge request response".into()))?;
    Ok(GitLabMergeRequest {
        number: value.iid,
        title: value.title,
        url: value.web_url,
        state: value.state.clone(),
        draft: value.draft,
        head_sha: value.sha,
        head_ref: value.source_branch,
        base_ref: value.target_branch,
        merged: value.state == "merged" || value.merged_at.is_some(),
        merge_commit_sha: value.merge_commit_sha,
    })
}

pub async fn create_merge_request(
    repository: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    draft: bool,
) -> AppResult<GitLabMergeRequest> {
    let title = if draft {
        format!("Draft: {title}")
    } else {
        title.to_string()
    };
    let response = request(
        "POST",
        &format!("/projects/{}/merge_requests", project_id(repository)),
        Some(&serde_json::json!({
            "title": title,
            "description": body,
            "source_branch": head,
            "target_branch": base,
            "remove_source_branch": false
        })),
    )
    .await?;
    parse_merge_request(&response)
}

pub async fn get_merge_request(
    repository: &str,
    number: u64,
) -> AppResult<GitLabMergeRequest> {
    let response = request(
        "GET",
        &format!(
            "/projects/{}/merge_requests/{number}",
            project_id(repository)
        ),
        None,
    )
    .await?;
    parse_merge_request(&response)
}

pub async fn merge_merge_request(
    repository: &str,
    number: u64,
    expected_head_sha: &str,
    merge_method: &str,
) -> AppResult<GitLabMergeResult> {
    if !matches!(merge_method, "merge" | "squash") {
        return Err(AppError::InvalidRequest(
            "GitLab merge_method must be merge or squash".into(),
        ));
    }
    let current = get_merge_request(repository, number).await?;
    if current.head_sha != expected_head_sha {
        return Err(AppError::WorkspaceChanged {
            expected: expected_head_sha.to_string(),
            actual: current.head_sha,
        });
    }
    if current.merged {
        let sha = current.merge_commit_sha.ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "merge request !{number} is merged but GitLab did not return merge_commit_sha"
            ))
        })?;
        return Ok(GitLabMergeResult {
            merged: true,
            sha: Some(sha),
            message: "merge request was already merged; recovered from GitLab state".into(),
        });
    }
    if current.state != "opened" {
        return Err(AppError::InvalidRequest(format!(
            "merge request !{number} is not open"
        )));
    }
    if current.draft {
        return Err(AppError::InvalidRequest(format!(
            "merge request !{number} is still a draft"
        )));
    }

    let response = request(
        "PUT",
        &format!(
            "/projects/{}/merge_requests/{number}/merge",
            project_id(repository)
        ),
        Some(&serde_json::json!({
            "sha": expected_head_sha,
            "squash": merge_method == "squash",
            "should_remove_source_branch": false
        })),
    )
    .await?;
    let merged = parse_merge_request(&response)?;
    Ok(GitLabMergeResult {
        merged: merged.merged,
        sha: merged.merge_commit_sha,
        message: if merged.merged {
            "merge request merged".into()
        } else {
            "GitLab did not report the merge request as merged".into()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{repository_from_remote, valid_loopback_api_url};

    #[test]
    fn parses_supported_gitlab_remotes() {
        for remote in [
            "git@gitlab.com:group/project.git",
            "ssh://git@gitlab.com/group/project.git",
            "https://gitlab.com/group/project.git",
            "https://gitlab.com/group/sub/project",
        ] {
            assert!(repository_from_remote(remote).is_some(), "{remote}");
        }
        assert_eq!(
            repository_from_remote("https://gitlab.com/group/sub/project.git").as_deref(),
            Some("group/sub/project")
        );
    }

    #[test]
    fn loopback_override_is_literal_and_bounded() {
        assert!(valid_loopback_api_url("http://127.0.0.1:7445/api/v4"));
        assert!(!valid_loopback_api_url("http://localhost:7445/api/v4"));
        assert!(!valid_loopback_api_url("https://127.0.0.1:7445/api/v4"));
        assert!(!valid_loopback_api_url("http://user@127.0.0.1:7445/api/v4"));
    }
}
