use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    git,
    git_provider::{
        ProviderChangeRequest, ProviderIssue, ProviderIssueCreateRequest, ProviderMergeResult,
        ProviderPullCreateRequest, ProviderPullGetRequest, ProviderPullMergeRequest,
        provider_for_workspace,
    },
    git_recovery,
    service::AppState,
    task_transactions::{self, TaskIdRequest},
    workflow::{
        BranchCheckoutRequest, CommitRequest, CommitResponse, DefaultSyncRequest,
        DefaultSyncResponse, GitReview, PushRequest, PushResponse,
    },
};

const MAX_COMMIT_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TaskLifecycleView {
    pub task_id: String,
    pub phase: String,
    pub branch: Option<String>,
    pub reviewed_diff_sha256: Option<String>,
    pub commit_sha: Option<String>,
    pub push_sha: Option<String>,
    pub issue_number: Option<u64>,
    pub pull_number: Option<u64>,
    pub pull_head_sha: Option<String>,
    pub merge_sha: Option<String>,
    pub default_synced_head: Option<String>,
    pub updated_at: i64,
    pub provider: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskBranchCheckoutRequest {
    pub task_id: String,
    pub branch: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskCommitRequest {
    pub task_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskIssueCreateRequest {
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskPullCreateRequest {
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskPullMergeRequest {
    pub task_id: String,
    #[serde(default = "default_merge_method")]
    pub merge_method: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskBranchResult {
    pub lifecycle: TaskLifecycleView,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskReviewResult {
    pub lifecycle: TaskLifecycleView,
    pub review: GitReview,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskCommitResult {
    pub lifecycle: TaskLifecycleView,
    pub commit: CommitResponse,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskPushResult {
    pub lifecycle: TaskLifecycleView,
    pub push: PushResponse,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskIssueResult {
    pub lifecycle: TaskLifecycleView,
    pub issue: ProviderIssue,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskPullResult {
    pub lifecycle: TaskLifecycleView,
    pub pull: ProviderChangeRequest,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskMergeResult {
    pub lifecycle: TaskLifecycleView,
    pub merge: ProviderMergeResult,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskSyncResult {
    pub lifecycle: TaskLifecycleView,
    pub sync: DefaultSyncResponse,
    pub replayed: bool,
}

type LifecycleRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

fn default_merge_method() -> String {
    "squash".into()
}

fn rank(phase: &str) -> Option<u8> {
    match phase {
        "snapshot" => Some(0),
        "branched" => Some(1),
        "patched" => Some(2),
        "reviewed" => Some(3),
        "committed" => Some(4),
        "pushed" => Some(5),
        "pr_open" => Some(6),
        "merged" => Some(7),
        "completed" => Some(8),
        _ => None,
    }
}

fn at_least(phase: &str, expected: &str) -> bool {
    matches!((rank(phase), rank(expected)), (Some(actual), Some(required)) if actual >= required)
}

fn task_key(task_id: &str, operation: &str) -> String {
    format!("task:{task_id}:{operation}")
}

fn from_row(row: LifecycleRow) -> TaskLifecycleView {
    TaskLifecycleView {
        task_id: row.0,
        phase: row.1,
        branch: row.2,
        reviewed_diff_sha256: row.3,
        commit_sha: row.4,
        push_sha: row.5,
        issue_number: row.6.and_then(|value| u64::try_from(value).ok()),
        pull_number: row.7.and_then(|value| u64::try_from(value).ok()),
        pull_head_sha: row.8,
        merge_sha: row.9,
        default_synced_head: row.10,
        updated_at: row.11,
        provider: None,
    }
}

pub async fn load_view(state: &AppState, task_id: &str) -> AppResult<TaskLifecycleView> {
    let row: Option<LifecycleRow> = sqlx::query_as(
        "SELECT task_id, phase, branch, reviewed_diff_sha256, commit_sha, push_sha, \
                issue_number, pull_number, pull_head_sha, merge_sha, default_synced_head, updated_at \
         FROM task_lifecycle WHERE task_id=?1",
    )
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?;
    let mut view = row
        .map(from_row)
        .ok_or_else(|| AppError::InvalidRequest(format!("task lifecycle not found: {task_id}")))?;
    let workspace_id: Option<String> =
        sqlx::query_scalar("SELECT workspace_id FROM tasks WHERE id=?1")
            .bind(task_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some(workspace_id) = workspace_id {
        view.provider = state.workspaces.get(&workspace_id)?.provider;
    }
    Ok(view)
}

async fn record_event(
    state: &AppState,
    task_id: &str,
    event_type: &str,
    metadata: serde_json::Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO task_events(task_id, event_type, metadata_json, created_at) \
         VALUES(?1, ?2, ?3, unixepoch())",
    )
    .bind(task_id)
    .bind(event_type)
    .bind(serde_json::to_string(&metadata).map_err(anyhow::Error::from)?)
    .execute(&state.db)
    .await?;
    let phase = match event_type {
        "branch_checked_out" => Some("branched"),
        "git_reviewed" => Some("reviewed"),
        "git_committed" => Some("committed"),
        "git_pushed" => Some("pushed"),
        "pull_opened" => Some("pr_open"),
        "pull_merged" => Some("merged"),
        "default_synced" => Some("completed"),
        _ => None,
    };
    if let Some(phase) = phase {
        crate::observability::observe_task_transition(
            phase,
            metadata.get("provider").and_then(serde_json::Value::as_str),
        );
    }
    Ok(())
}

async fn task_snapshot(
    state: &AppState,
    task_id: &str,
) -> AppResult<task_transactions::TaskSnapshot> {
    task_transactions::get(
        state,
        TaskIdRequest {
            task_id: task_id.to_string(),
        },
    )
    .await
}

async fn persist_branch(
    state: &AppState,
    task_id: &str,
    branch: &str,
) -> AppResult<TaskLifecycleView> {
    sqlx::query(
        "UPDATE task_lifecycle SET phase='branched', branch=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(branch)
    .bind(task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        task_id,
        "branch_checked_out",
        serde_json::json!({ "branch": branch }),
    )
    .await?;
    load_view(state, task_id).await
}

pub async fn branch_checkout(
    state: &AppState,
    req: TaskBranchCheckoutRequest,
) -> AppResult<TaskBranchResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    if snapshot.task.status != "active" {
        return Err(AppError::InvalidRequest(format!(
            "task {} must be active before branch checkout",
            req.task_id
        )));
    }
    let lifecycle = load_view(state, &req.task_id).await?;
    let workspace = state.workspaces.get(&snapshot.task.workspace)?;
    let current_branch = git::current_branch(&workspace.root).await?;
    let current_head = git::head(&workspace.root).await?;
    let clean = git::status(&workspace.root).await?.is_empty();

    if at_least(&lifecycle.phase, "branched") {
        if lifecycle.branch.as_deref() == Some(req.branch.as_str())
            && current_branch == req.branch
            && current_head == snapshot.task.base_head
            && clean
        {
            return Ok(TaskBranchResult {
                lifecycle,
                replayed: true,
            });
        }
        return Err(AppError::InvalidRequest(
            "task branch lifecycle already exists but current repository state does not match it"
                .into(),
        ));
    }

    if current_branch == req.branch && current_head == snapshot.task.base_head && clean {
        return Ok(TaskBranchResult {
            lifecycle: persist_branch(state, &req.task_id, &req.branch).await?,
            replayed: true,
        });
    }
    if current_branch != workspace.default_branch {
        return Err(AppError::InvalidRequest(format!(
            "task branch checkout must start from configured default branch {}",
            workspace.default_branch
        )));
    }

    state
        .checkout_branch(BranchCheckoutRequest {
            workspace: snapshot.task.workspace,
            expected_head: snapshot.task.base_head,
            branch: req.branch.clone(),
            request_id: Some(task_key(&req.task_id, "branch")),
        })
        .await?;
    Ok(TaskBranchResult {
        lifecycle: persist_branch(state, &req.task_id, &req.branch).await?,
        replayed: false,
    })
}

pub async fn review(state: &AppState, req: TaskIdRequest) -> AppResult<TaskReviewResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    if snapshot.task.status != "applied" {
        return Err(AppError::InvalidRequest(
            "task patch must be applied before lifecycle review".into(),
        ));
    }
    let lifecycle = load_view(state, &req.task_id).await?;
    if !at_least(&lifecycle.phase, "patched") || at_least(&lifecycle.phase, "committed") {
        return Err(AppError::InvalidRequest(format!(
            "task lifecycle phase {} cannot be reviewed",
            lifecycle.phase
        )));
    }
    let review = state.git_review(&snapshot.task.workspace).await?;
    if lifecycle.branch.as_deref() != Some(review.branch.as_str()) {
        return Err(AppError::InvalidRequest(
            "current branch does not match the task lifecycle branch".into(),
        ));
    }
    if review.head != snapshot.task.base_head || !review.dirty || review.diff.is_empty() {
        return Err(AppError::InvalidRequest(
            "task review requires the applied patch to be the only dirty delta on the task base HEAD"
                .into(),
        ));
    }
    if let Some(expected) = lifecycle.reviewed_diff_sha256.as_deref() {
        if expected != review.diff_sha256 {
            return Err(AppError::InvalidRequest(format!(
                "task reviewed diff changed: expected {expected}, current {}",
                review.diff_sha256
            )));
        }
        return Ok(TaskReviewResult {
            lifecycle,
            review,
            replayed: true,
        });
    }

    sqlx::query(
        "UPDATE task_lifecycle SET phase='reviewed', reviewed_diff_sha256=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(&review.diff_sha256)
    .bind(&req.task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        &req.task_id,
        "git_reviewed",
        serde_json::json!({ "diff_sha256": review.diff_sha256 }),
    )
    .await?;
    Ok(TaskReviewResult {
        lifecycle: load_view(state, &req.task_id).await?,
        review,
        replayed: false,
    })
}

async fn persist_commit(
    state: &AppState,
    task_id: &str,
    commit: &str,
    recovered: bool,
) -> AppResult<TaskLifecycleView> {
    sqlx::query(
        "UPDATE task_lifecycle SET phase='committed', commit_sha=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(commit)
    .bind(task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        task_id,
        "git_committed",
        serde_json::json!({ "commit_sha": commit, "recovered": recovered }),
    )
    .await?;
    load_view(state, task_id).await
}

pub async fn commit(state: &AppState, req: TaskCommitRequest) -> AppResult<TaskCommitResult> {
    if req.message.trim().is_empty() || req.message.len() > MAX_COMMIT_MESSAGE_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "commit message must be 1-{MAX_COMMIT_MESSAGE_BYTES} bytes"
        )));
    }
    let snapshot = task_snapshot(state, &req.task_id).await?;
    if snapshot.task.status != "applied" {
        return Err(AppError::InvalidRequest(
            "task patch must be applied before commit".into(),
        ));
    }
    let lifecycle = load_view(state, &req.task_id).await?;
    if !at_least(&lifecycle.phase, "reviewed") {
        return Err(AppError::InvalidRequest(
            "task diff must be reviewed before commit".into(),
        ));
    }
    let workspace = state.workspaces.get(&snapshot.task.workspace)?;
    let branch = git::current_branch(&workspace.root).await?;
    if lifecycle.branch.as_deref() != Some(branch.as_str()) {
        return Err(AppError::InvalidRequest(
            "current branch does not match task lifecycle branch".into(),
        ));
    }
    let current_head = git::head(&workspace.root).await?;
    let status = git::status(&workspace.root).await?;

    if let Some(commit_sha) = lifecycle.commit_sha.clone() {
        if current_head != commit_sha || !status.is_empty() {
            return Err(AppError::InvalidRequest(
                "persisted task commit does not match current clean repository HEAD".into(),
            ));
        }
        return Ok(TaskCommitResult {
            lifecycle,
            commit: CommitResponse {
                workspace: snapshot.task.workspace,
                branch,
                parent_head: snapshot.task.base_head,
                commit: commit_sha,
                clean: true,
                status,
            },
            replayed: true,
        });
    }

    if current_head != snapshot.task.base_head {
        let parent = git_recovery::first_parent(&workspace.root, &current_head).await?;
        if status.is_empty() && parent.as_deref() == Some(snapshot.task.base_head.as_str()) {
            let persisted = persist_commit(state, &req.task_id, &current_head, true).await?;
            return Ok(TaskCommitResult {
                lifecycle: persisted,
                commit: CommitResponse {
                    workspace: snapshot.task.workspace,
                    branch,
                    parent_head: snapshot.task.base_head,
                    commit: current_head,
                    clean: true,
                    status,
                },
                replayed: true,
            });
        }
        return Err(AppError::WorkspaceChanged {
            expected: snapshot.task.base_head,
            actual: current_head,
        });
    }

    let reviewed = lifecycle.reviewed_diff_sha256.clone().ok_or_else(|| {
        AppError::InvalidRequest("task lifecycle has no reviewed diff SHA".into())
    })?;
    let current_review = state.git_review(&snapshot.task.workspace).await?;
    if current_review.diff_sha256 != reviewed {
        return Err(AppError::InvalidRequest(format!(
            "working diff changed after review: expected {reviewed}, current {}",
            current_review.diff_sha256
        )));
    }
    let response = state
        .commit_reviewed(CommitRequest {
            workspace: snapshot.task.workspace,
            expected_head: snapshot.task.base_head,
            expected_diff_sha256: reviewed,
            message: req.message,
            request_id: Some(task_key(&req.task_id, "commit")),
        })
        .await?;
    Ok(TaskCommitResult {
        lifecycle: persist_commit(state, &req.task_id, &response.commit, false).await?,
        commit: response,
        replayed: false,
    })
}

async fn persist_push(
    state: &AppState,
    task_id: &str,
    push_sha: &str,
    recovered: bool,
) -> AppResult<TaskLifecycleView> {
    sqlx::query(
        "UPDATE task_lifecycle SET phase='pushed', push_sha=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(push_sha)
    .bind(task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        task_id,
        "git_pushed",
        serde_json::json!({ "push_sha": push_sha, "recovered": recovered }),
    )
    .await?;
    load_view(state, task_id).await
}

pub async fn push(state: &AppState, req: TaskIdRequest) -> AppResult<TaskPushResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    let commit_sha = lifecycle.commit_sha.clone().ok_or_else(|| {
        AppError::InvalidRequest("task must have a persisted commit before push".into())
    })?;
    let branch = lifecycle
        .branch
        .clone()
        .ok_or_else(|| AppError::InvalidRequest("task lifecycle branch is missing".into()))?;
    let workspace = state.workspaces.get(&snapshot.task.workspace)?;
    if git::current_branch(&workspace.root).await? != branch
        || git::head(&workspace.root).await? != commit_sha
        || !git::status(&workspace.root).await?.is_empty()
    {
        return Err(AppError::InvalidRequest(
            "current clean repository state does not match task commit before push".into(),
        ));
    }

    if lifecycle.push_sha.as_deref() == Some(commit_sha.as_str()) {
        return Ok(TaskPushResult {
            lifecycle,
            push: PushResponse {
                workspace: snapshot.task.workspace,
                remote: workspace.remote,
                branch,
                head: commit_sha,
            },
            replayed: true,
        });
    }
    if git::remote_branch_head(&workspace.root, &workspace.remote, &branch)
        .await?
        .as_deref()
        == Some(commit_sha.as_str())
    {
        return Ok(TaskPushResult {
            lifecycle: persist_push(state, &req.task_id, &commit_sha, true).await?,
            push: PushResponse {
                workspace: snapshot.task.workspace,
                remote: workspace.remote,
                branch,
                head: commit_sha,
            },
            replayed: true,
        });
    }

    let response = state
        .push_current_branch(PushRequest {
            workspace: snapshot.task.workspace,
            expected_head: commit_sha.clone(),
            request_id: Some(task_key(&req.task_id, "push")),
        })
        .await?;
    Ok(TaskPushResult {
        lifecycle: persist_push(state, &req.task_id, &response.head, false).await?,
        push: response,
        replayed: false,
    })
}

pub async fn issue_create(
    state: &AppState,
    req: TaskIssueCreateRequest,
) -> AppResult<TaskIssueResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    if !at_least(&lifecycle.phase, "pushed") {
        return Err(AppError::InvalidRequest(
            "task must be pushed before creating a lifecycle issue".into(),
        ));
    }
    let replayed = lifecycle.issue_number.is_some();
    let issue = state
        .provider_issue_create(ProviderIssueCreateRequest {
            workspace: snapshot.task.workspace,
            title: req.title,
            body: req.body,
            idempotency_key: Some(task_key(&req.task_id, "issue")),
        })
        .await?;
    if let Some(existing) = lifecycle.issue_number {
        if existing != issue.number {
            return Err(AppError::InvalidRequest(
                "provider idempotency replay returned a different issue number".into(),
            ));
        }
    } else {
        sqlx::query(
            "UPDATE task_lifecycle SET issue_number=?1, updated_at=unixepoch() WHERE task_id=?2",
        )
        .bind(i64::try_from(issue.number).map_err(|_| {
            AppError::InvalidRequest("issue number exceeds SQLite integer range".into())
        })?)
        .bind(&req.task_id)
        .execute(&state.db)
        .await?;
        record_event(
            state,
            &req.task_id,
            "provider_issue_created",
            serde_json::json!({ "provider": issue.provider, "issue_number": issue.number }),
        )
        .await?;
    }
    Ok(TaskIssueResult {
        lifecycle: load_view(state, &req.task_id).await?,
        issue,
        replayed,
    })
}

pub async fn pull_create(
    state: &AppState,
    req: TaskPullCreateRequest,
) -> AppResult<TaskPullResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    let push_sha = lifecycle.push_sha.clone().ok_or_else(|| {
        AppError::InvalidRequest("task must be pushed before creating a pull request".into())
    })?;
    if at_least(&lifecycle.phase, "merged") {
        let number = lifecycle.pull_number.ok_or_else(|| {
            AppError::InvalidRequest("merged task lifecycle has no pull request".into())
        })?;
        let pull = state
            .provider_pull_get(ProviderPullGetRequest {
                workspace: snapshot.task.workspace,
                pull_number: number,
            })
            .await?;
        return Ok(TaskPullResult {
            lifecycle,
            pull,
            replayed: true,
        });
    }
    let replayed = lifecycle.pull_number.is_some();
    let pull = state
        .provider_pull_create(ProviderPullCreateRequest {
            workspace: snapshot.task.workspace,
            expected_head: push_sha,
            title: req.title,
            body: req.body,
            base: req.base,
            draft: req.draft,
            idempotency_key: Some(task_key(&req.task_id, "pull")),
        })
        .await?;
    if let Some(existing) = lifecycle.pull_number {
        if existing != pull.number {
            return Err(AppError::InvalidRequest(
                "provider idempotency replay returned a different pull request number".into(),
            ));
        }
    } else {
        sqlx::query(
            "UPDATE task_lifecycle SET phase='pr_open', pull_number=?1, pull_head_sha=?2, updated_at=unixepoch() WHERE task_id=?3",
        )
        .bind(i64::try_from(pull.number).map_err(|_| AppError::InvalidRequest("pull number exceeds SQLite integer range".into()))?)
        .bind(&pull.head_sha)
        .bind(&req.task_id)
        .execute(&state.db)
        .await?;
        record_event(
            state,
            &req.task_id,
            "pull_opened",
            serde_json::json!({ "provider": pull.provider, "pull_number": pull.number, "head_sha": pull.head_sha }),
        )
        .await?;
    }
    Ok(TaskPullResult {
        lifecycle: load_view(state, &req.task_id).await?,
        pull,
        replayed,
    })
}

pub async fn pull_get(state: &AppState, req: TaskIdRequest) -> AppResult<TaskPullResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    let pull_number = lifecycle
        .pull_number
        .ok_or_else(|| AppError::InvalidRequest("task lifecycle has no pull request".into()))?;
    let pull = state
        .provider_pull_get(ProviderPullGetRequest {
            workspace: snapshot.task.workspace,
            pull_number,
        })
        .await?;
    if lifecycle.pull_head_sha.as_deref() != Some(pull.head_sha.as_str()) {
        sqlx::query(
            "UPDATE task_lifecycle SET pull_head_sha=?1, updated_at=unixepoch() WHERE task_id=?2",
        )
        .bind(&pull.head_sha)
        .bind(&req.task_id)
        .execute(&state.db)
        .await?;
        record_event(
            state,
            &req.task_id,
            "pull_observed",
            serde_json::json!({ "provider": pull.provider, "pull_number": pull.number, "head_sha": pull.head_sha }),
        )
        .await?;
    }
    Ok(TaskPullResult {
        lifecycle: load_view(state, &req.task_id).await?,
        pull,
        replayed: false,
    })
}

pub async fn pull_merge(state: &AppState, req: TaskPullMergeRequest) -> AppResult<TaskMergeResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    let pull_number = lifecycle
        .pull_number
        .ok_or_else(|| AppError::InvalidRequest("task lifecycle has no pull request".into()))?;
    let push_sha = lifecycle
        .push_sha
        .clone()
        .ok_or_else(|| AppError::InvalidRequest("task lifecycle has no pushed SHA".into()))?;
    if let Some(merge_sha) = lifecycle.merge_sha.clone() {
        return Ok(TaskMergeResult {
            lifecycle,
            merge: ProviderMergeResult {
                provider: provider_for_workspace(&state.workspaces.get(&snapshot.task.workspace)?)?
                    .to_string(),
                merged: true,
                sha: Some(merge_sha),
                message: "task lifecycle merge already persisted".into(),
            },
            replayed: true,
        });
    }
    let current = state
        .provider_pull_get(ProviderPullGetRequest {
            workspace: snapshot.task.workspace.clone(),
            pull_number,
        })
        .await?;
    if current.head_sha != push_sha {
        return Err(AppError::WorkspaceChanged {
            expected: push_sha,
            actual: current.head_sha,
        });
    }
    let merge = state
        .provider_pull_merge(ProviderPullMergeRequest {
            workspace: snapshot.task.workspace,
            pull_number,
            expected_head_sha: current.head_sha,
            merge_method: req.merge_method,
            idempotency_key: Some(task_key(&req.task_id, "merge")),
        })
        .await?;
    if !merge.merged {
        return Err(AppError::InvalidRequest(format!(
            "{} did not merge change request #{pull_number}: {}",
            merge.provider, merge.message
        )));
    }
    sqlx::query(
        "UPDATE task_lifecycle SET phase='merged', merge_sha=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(&merge.sha)
    .bind(&req.task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        &req.task_id,
        "pull_merged",
        serde_json::json!({ "provider": merge.provider, "pull_number": pull_number, "merge_sha": merge.sha }),
    )
    .await?;
    Ok(TaskMergeResult {
        lifecycle: load_view(state, &req.task_id).await?,
        merge,
        replayed: false,
    })
}

pub async fn default_sync(state: &AppState, req: TaskIdRequest) -> AppResult<TaskSyncResult> {
    let snapshot = task_snapshot(state, &req.task_id).await?;
    let lifecycle = load_view(state, &req.task_id).await?;
    if lifecycle.phase == "completed" {
        let workspace = state.workspaces.get(&snapshot.task.workspace)?;
        let head = lifecycle.default_synced_head.clone().ok_or_else(|| {
            AppError::InvalidRequest("completed lifecycle is missing default synced HEAD".into())
        })?;
        return Ok(TaskSyncResult {
            lifecycle,
            sync: DefaultSyncResponse {
                workspace: snapshot.task.workspace,
                branch: workspace.default_branch,
                head,
            },
            replayed: true,
        });
    }
    if lifecycle.phase != "merged" {
        return Err(AppError::InvalidRequest(
            "task pull request must be merged before default sync".into(),
        ));
    }
    let sync = state
        .sync_default_branch(DefaultSyncRequest {
            workspace: snapshot.task.workspace,
            request_id: Some(task_key(&req.task_id, "sync")),
        })
        .await?;
    sqlx::query(
        "UPDATE task_lifecycle SET phase='completed', default_synced_head=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(&sync.head)
    .bind(&req.task_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        &req.task_id,
        "task_completed",
        serde_json::json!({ "default_synced_head": sync.head }),
    )
    .await?;
    Ok(TaskSyncResult {
        lifecycle: load_view(state, &req.task_id).await?,
        sync,
        replayed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{at_least, rank, task_key};

    #[test]
    fn lifecycle_order_is_monotonic() {
        assert!(at_least("completed", "snapshot"));
        assert!(at_least("pushed", "reviewed"));
        assert!(!at_least("branched", "patched"));
        assert_eq!(rank("unknown"), None);
    }

    #[test]
    fn derived_keys_are_stable_and_bounded_for_uuid_tasks() {
        let key = task_key("550e8400-e29b-41d4-a716-446655440000", "merge");
        assert_eq!(key, "task:550e8400-e29b-41d4-a716-446655440000:merge");
        assert!(key.len() <= 128);
    }
}
