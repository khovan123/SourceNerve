use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    git, github, memory, ops,
    service::AppState,
    workspace::Workspace,
};

const MAX_REVIEW_DIFF_BYTES: usize = 2_000_000;
const MAX_GITHUB_BODY_BYTES: usize = 1_000_000;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BranchCheckoutRequest {
    pub workspace: String,
    pub expected_head: String,
    pub branch: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct BranchCheckoutResponse {
    pub workspace: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DefaultSyncRequest {
    pub workspace: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DefaultSyncResponse {
    pub workspace: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct GitReview {
    pub workspace: String,
    pub branch: String,
    pub head: String,
    pub dirty: bool,
    pub status: String,
    pub diff: String,
    pub diff_sha256: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CommitRequest {
    pub workspace: String,
    pub expected_head: String,
    pub expected_diff_sha256: String,
    pub message: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct CommitResponse {
    pub workspace: String,
    pub branch: String,
    pub parent_head: String,
    pub commit: String,
    pub clean: bool,
    pub status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PushRequest {
    pub workspace: String,
    pub expected_head: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct PushResponse {
    pub workspace: String,
    pub remote: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GitHubIssueCreateRequest {
    pub workspace: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GitHubPullCreateRequest {
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
pub struct GitHubPullGetRequest {
    pub workspace: String,
    pub pull_number: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GitHubPullMergeRequest {
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

fn validate_title(title: &str) -> AppResult<()> {
    if title.trim().is_empty() || title.len() > 256 {
        return Err(AppError::InvalidRequest(
            "title must be between 1 and 256 bytes".into(),
        ));
    }
    Ok(())
}

fn validate_body(body: &str) -> AppResult<()> {
    if body.len() > MAX_GITHUB_BODY_BYTES {
        return Err(AppError::InvalidRequest(
            "GitHub body exceeds 1 MB limit".into(),
        ));
    }
    Ok(())
}

fn ensure_writable(workspace: &Workspace) -> AppResult<()> {
    if workspace.writable {
        Ok(())
    } else {
        Err(AppError::ReadOnlyWorkspace)
    }
}

fn diff_hash(diff: &str) -> String {
    hex::encode(Sha256::digest(diff.as_bytes()))
}

impl AppState {
    fn github_token(&self) -> AppResult<Arc<String>> {
        self.github_token.clone().ok_or_else(|| {
            AppError::InvalidRequest(
                "GitHub lifecycle is not configured; set SOURCENERVE_GITHUB_TOKEN".into(),
            )
        })
    }

    async fn github_repository(&self, workspace: &Workspace) -> AppResult<String> {
        github::repository_for_workspace(
            &workspace.root,
            &workspace.remote,
            workspace.github_repository.as_deref(),
        )
        .await
    }

    async fn audit_mutation<T>(
        &self,
        workspace: &str,
        operation: &str,
        request_id: Option<&str>,
        target: serde_json::Value,
        result: &AppResult<T>,
        result_sha: Option<&str>,
    ) {
        if let Err(error) = ops::record_audit(
            self,
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
                "failed to persist sanitized mutation audit record"
            );
        }
    }

    pub async fn git_review(&self, workspace_id: &str) -> AppResult<GitReview> {
        let workspace = self.workspaces.get(workspace_id)?;
        let branch = git::current_branch(&workspace.root).await?;
        let head = git::head(&workspace.root).await?;
        let status = git::status(&workspace.root).await?;
        let diff = git::diff(&workspace.root).await?;
        if diff.len() > MAX_REVIEW_DIFF_BYTES {
            return Err(AppError::InvalidRequest(
                "review diff exceeds 2 MB response limit".into(),
            ));
        }
        Ok(GitReview {
            workspace: workspace_id.to_string(),
            branch,
            head,
            dirty: !status.is_empty(),
            status,
            diff_sha256: diff_hash(&diff),
            diff,
        })
    }

    pub async fn checkout_branch(
        &self,
        request: BranchCheckoutRequest,
    ) -> AppResult<BranchCheckoutResponse> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_request = request.request_id.clone();
        let audit_target = serde_json::json!({"branch": request.branch.clone()});
        let result: AppResult<BranchCheckoutResponse> = async {
            ops::validate_request_key(request.request_id.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            let head = git::head(&workspace.root).await?;
            if head != request.expected_head {
                return Err(AppError::WorkspaceChanged {
                    expected: request.expected_head,
                    actual: head,
                });
            }
            let status = git::status(&workspace.root).await?;
            if !status.is_empty() {
                return Err(AppError::InvalidRequest(
                    "working tree must be clean before creating a branch".into(),
                ));
            }
            if request.branch == workspace.default_branch {
                return Err(AppError::InvalidRequest(
                    "feature branch must differ from the configured default branch".into(),
                ));
            }
            git::checkout_new_branch(&workspace.root, &request.branch).await?;
            Ok(BranchCheckoutResponse {
                workspace: request.workspace,
                branch: request.branch,
                head,
            })
        }
        .await;
        let result_sha = result.as_ref().ok().map(|response| response.head.as_str());
        self.audit_mutation(
            &audit_workspace,
            "git_branch_checkout",
            audit_request.as_deref(),
            audit_target,
            &result,
            result_sha,
        )
        .await;
        result
    }

    pub async fn sync_default_branch(
        &self,
        request: DefaultSyncRequest,
    ) -> AppResult<DefaultSyncResponse> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_request = request.request_id.clone();
        let default_branch = self
            .workspaces
            .get(&request.workspace)
            .ok()
            .map(|workspace| workspace.default_branch)
            .unwrap_or_default();
        let result: AppResult<DefaultSyncResponse> = async {
            ops::validate_request_key(request.request_id.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            let status = git::status(&workspace.root).await?;
            if !status.is_empty() {
                return Err(AppError::InvalidRequest(
                    "working tree must be clean before syncing the default branch".into(),
                ));
            }
            let head = git::sync_default(
                &workspace.root,
                &workspace.remote,
                &workspace.default_branch,
            )
            .await?;
            let indexed = memory::index_workspace_locked(self, &workspace.id).await?;
            if indexed.head != head {
                return Err(AppError::WorkspaceChanged {
                    expected: head,
                    actual: indexed.head,
                });
            }
            Ok(DefaultSyncResponse {
                workspace: workspace.id,
                branch: workspace.default_branch,
                head: indexed.head,
            })
        }
        .await;
        let result_sha = result.as_ref().ok().map(|response| response.head.as_str());
        self.audit_mutation(
            &audit_workspace,
            "git_default_sync",
            audit_request.as_deref(),
            serde_json::json!({"branch": default_branch}),
            &result,
            result_sha,
        )
        .await;
        result
    }

    pub async fn commit_reviewed(&self, request: CommitRequest) -> AppResult<CommitResponse> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_request = request.request_id.clone();
        let result: AppResult<CommitResponse> = async {
            ops::validate_request_key(request.request_id.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            let branch = git::current_branch(&workspace.root).await?;
            if branch == workspace.default_branch {
                return Err(AppError::InvalidRequest(
                    "committing directly on the configured default branch is not allowed".into(),
                ));
            }
            let head = git::head(&workspace.root).await?;
            if head != request.expected_head {
                return Err(AppError::WorkspaceChanged {
                    expected: request.expected_head,
                    actual: head,
                });
            }
            let diff = git::diff(&workspace.root).await?;
            if diff.is_empty() {
                return Err(AppError::InvalidRequest(
                    "there is nothing to commit".into(),
                ));
            }
            let actual_diff_hash = diff_hash(&diff);
            if actual_diff_hash != request.expected_diff_sha256 {
                return Err(AppError::InvalidRequest(format!(
                    "working diff changed: expected SHA-256 {}, current {}",
                    request.expected_diff_sha256, actual_diff_hash
                )));
            }
            let commit = git::commit_all(&workspace.root, &request.message).await?;
            let status = git::status(&workspace.root).await?;
            Ok(CommitResponse {
                workspace: request.workspace,
                branch,
                parent_head: head,
                commit,
                clean: status.is_empty(),
                status,
            })
        }
        .await;
        let result_sha = result
            .as_ref()
            .ok()
            .map(|response| response.commit.as_str());
        let branch = result
            .as_ref()
            .ok()
            .map(|response| response.branch.clone())
            .unwrap_or_default();
        self.audit_mutation(
            &audit_workspace,
            "git_commit",
            audit_request.as_deref(),
            serde_json::json!({"branch": branch}),
            &result,
            result_sha,
        )
        .await;
        result
    }

    pub async fn push_current_branch(&self, request: PushRequest) -> AppResult<PushResponse> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_request = request.request_id.clone();
        let result: AppResult<PushResponse> = async {
            ops::validate_request_key(request.request_id.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            let branch = git::current_branch(&workspace.root).await?;
            if branch == workspace.default_branch {
                return Err(AppError::InvalidRequest(
                    "pushing the configured default branch through SourceNerve is not allowed"
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
                    "working tree must be clean before push".into(),
                ));
            }
            let (pushed_branch, pushed_head) =
                git::push_current(&workspace.root, &workspace.remote).await?;
            let remote_head =
                git::remote_branch_head(&workspace.root, &workspace.remote, &pushed_branch).await?;
            if remote_head.as_deref() != Some(pushed_head.as_str()) {
                return Err(AppError::Command(
                    "remote branch did not resolve to the pushed local HEAD".into(),
                ));
            }
            Ok(PushResponse {
                workspace: request.workspace,
                remote: workspace.remote,
                branch: pushed_branch,
                head: pushed_head,
            })
        }
        .await;
        let result_sha = result.as_ref().ok().map(|response| response.head.as_str());
        let target = result
            .as_ref()
            .ok()
            .map(|response| {
                serde_json::json!({"remote": &response.remote, "branch": &response.branch})
            })
            .unwrap_or_else(|| serde_json::json!({}));
        self.audit_mutation(
            &audit_workspace,
            "git_push",
            audit_request.as_deref(),
            target,
            &result,
            result_sha,
        )
        .await;
        result
    }

    pub async fn github_issue_create(
        &self,
        request: GitHubIssueCreateRequest,
    ) -> AppResult<github::GitHubIssue> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_key = request.idempotency_key.clone();
        let result: AppResult<github::GitHubIssue> = async {
            ops::validate_request_key(request.idempotency_key.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            validate_title(&request.title)?;
            validate_body(&request.body)?;
            let fingerprint = ops::request_fingerprint(&serde_json::json!({
                "title": &request.title,
                "body": &request.body,
            }))?;
            if let Some(existing) = ops::idempotency_lookup::<github::GitHubIssue>(
                self,
                &workspace.id,
                "github_issue_create",
                request.idempotency_key.as_deref(),
                &fingerprint,
            )
            .await?
            {
                return Ok(existing);
            }
            let token = self.github_token()?;
            let repository = self.github_repository(&workspace).await?;
            let response =
                github::create_issue(&token, &repository, &request.title, &request.body).await?;
            ops::idempotency_store(
                self,
                &workspace.id,
                "github_issue_create",
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
            .map(|response| serde_json::json!({"issue_number": response.number}))
            .unwrap_or_else(|| serde_json::json!({"provider": "github"}));
        self.audit_mutation(
            &audit_workspace,
            "github_issue_create",
            audit_key.as_deref(),
            target,
            &result,
            None,
        )
        .await;
        result
    }

    pub async fn github_pull_create(
        &self,
        request: GitHubPullCreateRequest,
    ) -> AppResult<github::GitHubPullRequest> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_key = request.idempotency_key.clone();
        let result: AppResult<github::GitHubPullRequest> = async {
            ops::validate_request_key(request.idempotency_key.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            validate_title(&request.title)?;
            validate_body(&request.body)?;
            let branch = git::current_branch(&workspace.root).await?;
            if branch == workspace.default_branch {
                return Err(AppError::InvalidRequest(
                    "cannot open a pull request from the configured default branch".into(),
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
                    "working tree must be clean before creating a pull request".into(),
                ));
            }
            let remote_head =
                git::remote_branch_head(&workspace.root, &workspace.remote, &branch).await?;
            if remote_head.as_deref() != Some(head.as_str()) {
                return Err(AppError::InvalidRequest(
                    "current branch must be pushed and match local HEAD before creating a pull request"
                        .into(),
                ));
            }
            let base = request
                .base
                .clone()
                .unwrap_or_else(|| workspace.default_branch.clone());
            if base == branch {
                return Err(AppError::InvalidRequest(
                    "pull request base and head branch must differ".into(),
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
            if let Some(existing) = ops::idempotency_lookup::<github::GitHubPullRequest>(
                self,
                &workspace.id,
                "github_pull_create",
                request.idempotency_key.as_deref(),
                &fingerprint,
            )
            .await?
            {
                return Ok(existing);
            }
            let token = self.github_token()?;
            let repository = self.github_repository(&workspace).await?;
            let response = github::create_pull_request(
                &token,
                &repository,
                &request.title,
                &request.body,
                &branch,
                &base,
                request.draft,
            )
            .await?;
            ops::idempotency_store(
                self,
                &workspace.id,
                "github_pull_create",
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
                    "pull_number": response.number,
                    "head": &response.head_ref,
                    "base": &response.base_ref,
                })
            })
            .unwrap_or_else(|| serde_json::json!({"provider": "github"}));
        self.audit_mutation(
            &audit_workspace,
            "github_pull_create",
            audit_key.as_deref(),
            target,
            &result,
            result_sha,
        )
        .await;
        result
    }

    pub async fn github_pull_get(
        &self,
        request: GitHubPullGetRequest,
    ) -> AppResult<github::GitHubPullRequest> {
        let workspace = self.workspaces.get(&request.workspace)?;
        let token = self.github_token()?;
        let repository = self.github_repository(&workspace).await?;
        github::get_pull_request(&token, &repository, request.pull_number).await
    }

    pub async fn github_pull_merge(
        &self,
        request: GitHubPullMergeRequest,
    ) -> AppResult<github::GitHubMergeResult> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = request.workspace.clone();
        let audit_key = request.idempotency_key.clone();
        let audit_pull = request.pull_number;
        let result: AppResult<github::GitHubMergeResult> = async {
            ops::validate_request_key(request.idempotency_key.as_deref())?;
            let workspace = self.workspaces.get(&request.workspace)?;
            ensure_writable(&workspace)?;
            let fingerprint = ops::request_fingerprint(&serde_json::json!({
                "pull_number": request.pull_number,
                "expected_head_sha": &request.expected_head_sha,
                "merge_method": &request.merge_method,
            }))?;
            if let Some(existing) = ops::idempotency_lookup::<github::GitHubMergeResult>(
                self,
                &workspace.id,
                "github_pull_merge",
                request.idempotency_key.as_deref(),
                &fingerprint,
            )
            .await?
            {
                return Ok(existing);
            }
            let token = self.github_token()?;
            let repository = self.github_repository(&workspace).await?;
            let response = github::merge_pull_request(
                &token,
                &repository,
                request.pull_number,
                &request.expected_head_sha,
                &request.merge_method,
            )
            .await?;
            ops::idempotency_store(
                self,
                &workspace.id,
                "github_pull_merge",
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
        self.audit_mutation(
            &audit_workspace,
            "github_pull_merge",
            audit_key.as_deref(),
            serde_json::json!({"pull_number": audit_pull}),
            &result,
            result_sha,
        )
        .await;
        result
    }
}
