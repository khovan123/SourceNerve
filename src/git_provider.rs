use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    git, github, gitlab, ops,
    service::AppState,
    workflow::{
        GitHubIssueCreateRequest, GitHubPullCreateRequest, GitHubPullGetRequest,
        GitHubPullMergeRequest,
    },
    workspace::Workspace,
};

const MAX_BODY_BYTES: usize = 1_000_000;

fn default_github_provider() -> String {
    "github".into()
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct ProviderIssue {
    #[serde(default = "default_github_provider")]
    pub provider: String,
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct ProviderChangeRequest {
    #[serde(default = "default_github_provider")]
    pub provider: String,
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
pub struct ProviderMergeResult {
    #[serde(default = "default_github_provider")]
    pub provider: String,
    pub merged: bool,
    pub sha: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProviderIssueCreateRequest {
    pub workspace: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProviderPullCreateRequest {
    pub workspace: String,
    pub expected_head: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProviderPullGetRequest {
    pub workspace: String,
    pub pull_number: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProviderPullMergeRequest {
    pub workspace: String,
    pub pull_number: u64,
    pub expected_head_sha: String,
    #[serde(default = "default_merge_method")]
    pub merge_method: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

fn default_merge_method() -> String {
    "squash".into()
}

impl From<github::GitHubIssue> for ProviderIssue {
    fn from(value: github::GitHubIssue) -> Self {
        Self {
            provider: "github".into(),
            number: value.number,
            title: value.title,
            url: value.url,
        }
    }
}

impl From<gitlab::GitLabIssue> for ProviderIssue {
    fn from(value: gitlab::GitLabIssue) -> Self {
        Self {
            provider: "gitlab".into(),
            number: value.number,
            title: value.title,
            url: value.url,
        }
    }
}

impl From<github::GitHubPullRequest> for ProviderChangeRequest {
    fn from(value: github::GitHubPullRequest) -> Self {
        Self {
            provider: "github".into(),
            number: value.number,
            title: value.title,
            url: value.url,
            state: value.state,
            draft: value.draft,
            head_sha: value.head_sha,
            head_ref: value.head_ref,
            base_ref: value.base_ref,
            merged: value.merged,
            merge_commit_sha: value.merge_commit_sha,
        }
    }
}

impl From<gitlab::GitLabMergeRequest> for ProviderChangeRequest {
    fn from(value: gitlab::GitLabMergeRequest) -> Self {
        Self {
            provider: "gitlab".into(),
            number: value.number,
            title: value.title,
            url: value.url,
            state: value.state,
            draft: value.draft,
            head_sha: value.head_sha,
            head_ref: value.head_ref,
            base_ref: value.base_ref,
            merged: value.merged,
            merge_commit_sha: value.merge_commit_sha,
        }
    }
}

impl From<github::GitHubMergeResult> for ProviderMergeResult {
    fn from(value: github::GitHubMergeResult) -> Self {
        Self {
            provider: "github".into(),
            merged: value.merged,
            sha: value.sha,
            message: value.message,
        }
    }
}

impl From<gitlab::GitLabMergeResult> for ProviderMergeResult {
    fn from(value: gitlab::GitLabMergeResult) -> Self {
        Self {
            provider: "gitlab".into(),
            merged: value.merged,
            sha: value.sha,
            message: value.message,
        }
    }
}

fn ensure_writable(workspace: &Workspace) -> AppResult<()> {
    if workspace.writable {
        Ok(())
    } else {
        Err(AppError::ReadOnlyWorkspace)
    }
}

fn validate_title(title: &str) -> AppResult<()> {
    if title.trim().is_empty() || title.len() > 256 {
        return Err(AppError::InvalidRequest(
            "title must be between 1 and 256 bytes".into(),
        ));
    }
    Ok(())
}

fn validate_body(body: &str) -> AppResult<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::InvalidRequest(
            "provider body exceeds 1 MB limit".into(),
        ));
    }
    Ok(())
}

pub fn provider_for_workspace(workspace: &Workspace) -> AppResult<&str> {
    workspace.provider.as_deref().ok_or_else(|| {
        AppError::InvalidRequest(
            "workspace repository-host lifecycle is not configured; set workspace.provider to github or gitlab"
                .into(),
        )
    })
}

async fn repository_for_workspace(workspace: &Workspace) -> AppResult<String> {
    match provider_for_workspace(workspace)? {
        "github" => {
            let configured = workspace
                .repository
                .as_deref()
                .or(workspace.github_repository.as_deref());
            github::repository_for_workspace(&workspace.root, &workspace.remote, configured).await
        }
        "gitlab" => {
            gitlab::repository_for_workspace(
                &workspace.root,
                &workspace.remote,
                workspace.repository.as_deref(),
            )
            .await
        }
        provider => Err(AppError::InvalidRequest(format!(
            "unsupported workspace provider: {provider}"
        ))),
    }
}

async fn audit<T>(
    state: &AppState,
    workspace: &str,
    operation: &str,
    request_id: Option<&str>,
    target: serde_json::Value,
    result: &AppResult<T>,
    result_sha: Option<&str>,
) {
    if let Err(error) = ops::record_audit(
        state,
        workspace,
        operation,
        request_id,
        target,
        ops::audit_outcome(result),
        result_sha,
    )
    .await
    {
        tracing::error!(
            workspace,
            operation,
            error = %error,
            "failed to persist sanitized provider mutation audit record"
        );
    }
}

impl AppState {
    pub async fn provider_issue_create(
        &self,
        request: ProviderIssueCreateRequest,
    ) -> AppResult<ProviderIssue> {
        let workspace = self.workspaces.get(&request.workspace)?;
        match provider_for_workspace(&workspace)? {
            "github" => self
                .github_issue_create(GitHubIssueCreateRequest {
                    workspace: request.workspace,
                    title: request.title,
                    body: request.body,
                    idempotency_key: request.idempotency_key,
                })
                .await
                .map(ProviderIssue::from),
            "gitlab" => {
                let _guard = self.mutation_lock.lock().await;
                let audit_workspace = request.workspace.clone();
                let audit_key = request.idempotency_key.clone();
                let result: AppResult<ProviderIssue> = async {
                    ops::validate_request_key(request.idempotency_key.as_deref())?;
                    ensure_writable(&workspace)?;
                    validate_title(&request.title)?;
                    validate_body(&request.body)?;
                    let fingerprint = ops::request_fingerprint(&serde_json::json!({
                        "title": &request.title,
                        "body": &request.body,
                    }))?;
                    if let Some(existing) = ops::idempotency_lookup::<ProviderIssue>(
                        self,
                        &workspace.id,
                        "gitlab_issue_create",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                    )
                    .await?
                    {
                        return Ok(existing);
                    }
                    let repository = repository_for_workspace(&workspace).await?;
                    let response = ProviderIssue::from(
                        gitlab::create_issue(&repository, &request.title, &request.body).await?,
                    );
                    ops::idempotency_store(
                        self,
                        &workspace.id,
                        "gitlab_issue_create",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                        &response,
                    )
                    .await?;
                    Ok(response)
                }
                .await;
                let target = result
                    .as_ref()
                    .ok()
                    .map(|response| {
                        serde_json::json!({
                            "provider": "gitlab",
                            "issue_number": response.number
                        })
                    })
                    .unwrap_or_else(|| serde_json::json!({"provider": "gitlab"}));
                audit(
                    self,
                    &audit_workspace,
                    "gitlab_issue_create",
                    audit_key.as_deref(),
                    target,
                    &result,
                    None,
                )
                .await;
                result
            }
            provider => Err(AppError::InvalidRequest(format!(
                "unsupported workspace provider: {provider}"
            ))),
        }
    }

    pub async fn provider_pull_create(
        &self,
        request: ProviderPullCreateRequest,
    ) -> AppResult<ProviderChangeRequest> {
        let workspace = self.workspaces.get(&request.workspace)?;
        match provider_for_workspace(&workspace)? {
            "github" => self
                .github_pull_create(GitHubPullCreateRequest {
                    workspace: request.workspace,
                    expected_head: request.expected_head,
                    title: request.title,
                    body: request.body,
                    base: request.base,
                    draft: request.draft,
                    idempotency_key: request.idempotency_key,
                })
                .await
                .map(ProviderChangeRequest::from),
            "gitlab" => {
                let _guard = self.mutation_lock.lock().await;
                let audit_workspace = request.workspace.clone();
                let audit_key = request.idempotency_key.clone();
                let result: AppResult<ProviderChangeRequest> = async {
                    ops::validate_request_key(request.idempotency_key.as_deref())?;
                    ensure_writable(&workspace)?;
                    validate_title(&request.title)?;
                    validate_body(&request.body)?;
                    let branch = git::current_branch(&workspace.root).await?;
                    if branch == workspace.default_branch {
                        return Err(AppError::InvalidRequest(
                            "cannot open a change request from the configured default branch"
                                .into(),
                        ));
                    }
                    let head = git::head(&workspace.root).await?;
                    if head != request.expected_head {
                        return Err(AppError::WorkspaceChanged {
                            expected: request.expected_head,
                            actual: head,
                        });
                    }
                    if !git::status(&workspace.root).await?.is_empty() {
                        return Err(AppError::InvalidRequest(
                            "working tree must be clean before creating a change request".into(),
                        ));
                    }
                    let remote_head =
                        git::remote_branch_head(&workspace.root, &workspace.remote, &branch).await?;
                    if remote_head.as_deref() != Some(head.as_str()) {
                        return Err(AppError::InvalidRequest(
                            "current branch must be pushed and match local HEAD before creating a change request"
                                .into(),
                        ));
                    }
                    let base = request
                        .base
                        .clone()
                        .unwrap_or_else(|| workspace.default_branch.clone());
                    if base == branch {
                        return Err(AppError::InvalidRequest(
                            "change request base and head branch must differ".into(),
                        ));
                    }
                    let fingerprint = ops::request_fingerprint(&serde_json::json!({
                        "expected_head": &request.expected_head,
                        "title": &request.title,
                        "body": &request.body,
                        "head": &branch,
                        "base": &base,
                        "draft": request.draft,
                    }))?;
                    if let Some(existing) = ops::idempotency_lookup::<ProviderChangeRequest>(
                        self,
                        &workspace.id,
                        "gitlab_pull_create",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                    )
                    .await?
                    {
                        return Ok(existing);
                    }
                    let repository = repository_for_workspace(&workspace).await?;
                    let response = ProviderChangeRequest::from(
                        gitlab::create_merge_request(
                            &repository,
                            &request.title,
                            &request.body,
                            &branch,
                            &base,
                            request.draft,
                        )
                        .await?,
                    );
                    ops::idempotency_store(
                        self,
                        &workspace.id,
                        "gitlab_pull_create",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                        &response,
                    )
                    .await?;
                    Ok(response)
                }
                .await;
                let result_sha = result
                    .as_ref()
                    .ok()
                    .map(|response| response.head_sha.as_str());
                let target = result
                    .as_ref()
                    .ok()
                    .map(|response| {
                        serde_json::json!({
                            "provider": "gitlab",
                            "pull_number": response.number,
                            "head": response.head_ref,
                            "base": response.base_ref
                        })
                    })
                    .unwrap_or_else(|| serde_json::json!({"provider": "gitlab"}));
                audit(
                    self,
                    &audit_workspace,
                    "gitlab_pull_create",
                    audit_key.as_deref(),
                    target,
                    &result,
                    result_sha,
                )
                .await;
                result
            }
            provider => Err(AppError::InvalidRequest(format!(
                "unsupported workspace provider: {provider}"
            ))),
        }
    }

    pub async fn provider_pull_get(
        &self,
        request: ProviderPullGetRequest,
    ) -> AppResult<ProviderChangeRequest> {
        let workspace = self.workspaces.get(&request.workspace)?;
        match provider_for_workspace(&workspace)? {
            "github" => self
                .github_pull_get(GitHubPullGetRequest {
                    workspace: request.workspace,
                    pull_number: request.pull_number,
                })
                .await
                .map(ProviderChangeRequest::from),
            "gitlab" => {
                let repository = repository_for_workspace(&workspace).await?;
                gitlab::get_merge_request(&repository, request.pull_number)
                    .await
                    .map(ProviderChangeRequest::from)
            }
            provider => Err(AppError::InvalidRequest(format!(
                "unsupported workspace provider: {provider}"
            ))),
        }
    }

    pub async fn provider_pull_merge(
        &self,
        request: ProviderPullMergeRequest,
    ) -> AppResult<ProviderMergeResult> {
        let workspace = self.workspaces.get(&request.workspace)?;
        match provider_for_workspace(&workspace)? {
            "github" => self
                .github_pull_merge(GitHubPullMergeRequest {
                    workspace: request.workspace,
                    pull_number: request.pull_number,
                    expected_head_sha: request.expected_head_sha,
                    merge_method: request.merge_method,
                    idempotency_key: request.idempotency_key,
                })
                .await
                .map(ProviderMergeResult::from),
            "gitlab" => {
                let _guard = self.mutation_lock.lock().await;
                let audit_workspace = request.workspace.clone();
                let audit_key = request.idempotency_key.clone();
                let audit_pull = request.pull_number;
                let result: AppResult<ProviderMergeResult> = async {
                    ops::validate_request_key(request.idempotency_key.as_deref())?;
                    ensure_writable(&workspace)?;
                    let fingerprint = ops::request_fingerprint(&serde_json::json!({
                        "pull_number": request.pull_number,
                        "expected_head_sha": &request.expected_head_sha,
                        "merge_method": &request.merge_method,
                    }))?;
                    if let Some(existing) = ops::idempotency_lookup::<ProviderMergeResult>(
                        self,
                        &workspace.id,
                        "gitlab_pull_merge",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                    )
                    .await?
                    {
                        return Ok(existing);
                    }
                    let repository = repository_for_workspace(&workspace).await?;
                    let response = ProviderMergeResult::from(
                        gitlab::merge_merge_request(
                            &repository,
                            request.pull_number,
                            &request.expected_head_sha,
                            &request.merge_method,
                        )
                        .await?,
                    );
                    ops::idempotency_store(
                        self,
                        &workspace.id,
                        "gitlab_pull_merge",
                        request.idempotency_key.as_deref(),
                        &fingerprint,
                        &response,
                    )
                    .await?;
                    Ok(response)
                }
                .await;
                let result_sha = result
                    .as_ref()
                    .ok()
                    .and_then(|response| response.sha.as_deref());
                audit(
                    self,
                    &audit_workspace,
                    "gitlab_pull_merge",
                    audit_key.as_deref(),
                    serde_json::json!({
                        "provider": "gitlab",
                        "pull_number": audit_pull
                    }),
                    &result,
                    result_sha,
                )
                .await;
                result
            }
            provider => Err(AppError::InvalidRequest(format!(
                "unsupported workspace provider: {provider}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ProviderIssue, provider_for_workspace};
    use crate::workspace::Workspace;
    use std::path::PathBuf;

    #[test]
    fn old_github_idempotency_payload_defaults_provider() {
        let value: ProviderIssue = serde_json::from_str(
            r#"{"number":7,"title":"legacy","url":"https://github.com/a/b/issues/7"}"#,
        )
        .expect("legacy payload");
        assert_eq!(value.provider, "github");
    }

    #[test]
    fn provider_must_be_explicit_on_provider_neutral_surface() {
        let workspace = Workspace {
            id: "w".into(),
            name: "W".into(),
            root: PathBuf::from("."),
            writable: true,
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        };
        assert!(provider_for_workspace(&workspace).is_err());
    }
}
