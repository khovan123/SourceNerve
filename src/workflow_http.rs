use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    service::{AppState, WorkspaceArg},
    workflow::{
        BranchCheckoutRequest, CommitRequest, DefaultSyncRequest, GitHubIssueCreateRequest,
        GitHubPullCreateRequest, GitHubPullGetRequest, GitHubPullMergeRequest, PushRequest,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/git/review", post(git_review))
        .route("/git/branch/checkout", post(git_branch_checkout))
        .route("/git/default/sync", post(git_default_sync))
        .route("/git/commit", post(git_commit))
        .route("/git/push", post(git_push))
        .route("/github/issues", post(github_issue_create))
        .route("/github/pulls", post(github_pull_create))
        .route("/github/pulls/get", post(github_pull_get))
        .route("/github/pulls/merge", post(github_pull_merge))
}

async fn git_review(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.git_review(&request.workspace).await?).unwrap(),
    ))
}

async fn git_branch_checkout(
    State(state): State<AppState>,
    Json(request): Json<BranchCheckoutRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.checkout_branch(request).await?).unwrap(),
    ))
}

async fn git_default_sync(
    State(state): State<AppState>,
    Json(request): Json<DefaultSyncRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.sync_default_branch(request).await?).unwrap(),
    ))
}

async fn git_commit(
    State(state): State<AppState>,
    Json(request): Json<CommitRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.commit_reviewed(request).await?).unwrap(),
    ))
}

async fn git_push(
    State(state): State<AppState>,
    Json(request): Json<PushRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.push_current_branch(request).await?).unwrap(),
    ))
}

async fn github_issue_create(
    State(state): State<AppState>,
    Json(request): Json<GitHubIssueCreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.github_issue_create(request).await?).unwrap(),
    ))
}

async fn github_pull_create(
    State(state): State<AppState>,
    Json(request): Json<GitHubPullCreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.github_pull_create(request).await?).unwrap(),
    ))
}

async fn github_pull_get(
    State(state): State<AppState>,
    Json(request): Json<GitHubPullGetRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.github_pull_get(request).await?).unwrap(),
    ))
}

async fn github_pull_merge(
    State(state): State<AppState>,
    Json(request): Json<GitHubPullMergeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.github_pull_merge(request).await?).unwrap(),
    ))
}
