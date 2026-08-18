use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    service::AppState,
    task_lifecycle::{
        self, TaskBranchCheckoutRequest, TaskCommitRequest, TaskIssueCreateRequest,
        TaskPullCreateRequest, TaskPullMergeRequest,
    },
    task_transactions::{
        self, TaskApplyPatchRequest, TaskBeginRequest, TaskIdRequest, TaskProposePatchRequest,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks/begin", post(task_begin))
        .route("/tasks/get", post(task_get))
        .route("/tasks/cancel", post(task_cancel))
        .route("/tasks/proposals/create", post(task_propose_patch))
        .route("/tasks/proposals/apply", post(task_apply_patch))
        .route("/tasks/lifecycle/branch", post(task_branch_checkout))
        .route("/tasks/lifecycle/review", post(task_git_review))
        .route("/tasks/lifecycle/commit", post(task_git_commit))
        .route("/tasks/lifecycle/push", post(task_git_push))
        .route("/tasks/lifecycle/issues/create", post(task_issue_create))
        .route("/tasks/lifecycle/pulls/create", post(task_pull_create))
        .route("/tasks/lifecycle/pulls/get", post(task_pull_get))
        .route("/tasks/lifecycle/pulls/merge", post(task_pull_merge))
        .route("/tasks/lifecycle/default-sync", post(task_default_sync))
}

async fn task_begin(
    State(state): State<AppState>,
    Json(request): Json<TaskBeginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::begin(&state, request).await?).unwrap(),
    ))
}

async fn task_get(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let task_id = request.task_id.clone();
    let snapshot = task_transactions::get(&state, request).await?;
    let lifecycle = task_lifecycle::load_view(&state, &task_id).await?;
    let mut value = serde_json::to_value(snapshot).unwrap();
    if let serde_json::Value::Object(object) = &mut value {
        object.insert("lifecycle".into(), serde_json::to_value(lifecycle).unwrap());
    }
    Ok(Json(value))
}

async fn task_cancel(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::cancel(&state, request).await?).unwrap(),
    ))
}

async fn task_propose_patch(
    State(state): State<AppState>,
    Json(request): Json<TaskProposePatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::propose_patch(&state, request).await?).unwrap(),
    ))
}

async fn task_apply_patch(
    State(state): State<AppState>,
    Json(request): Json<TaskApplyPatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::apply_patch(&state, request).await?).unwrap(),
    ))
}

async fn task_branch_checkout(
    State(state): State<AppState>,
    Json(request): Json<TaskBranchCheckoutRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::branch_checkout(&state, request).await?).unwrap()))
}

async fn task_git_review(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::review(&state, request).await?).unwrap()))
}

async fn task_git_commit(
    State(state): State<AppState>,
    Json(request): Json<TaskCommitRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::commit(&state, request).await?).unwrap()))
}

async fn task_git_push(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::push(&state, request).await?).unwrap()))
}

async fn task_issue_create(
    State(state): State<AppState>,
    Json(request): Json<TaskIssueCreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::issue_create(&state, request).await?).unwrap()))
}

async fn task_pull_create(
    State(state): State<AppState>,
    Json(request): Json<TaskPullCreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::pull_create(&state, request).await?).unwrap()))
}

async fn task_pull_get(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::pull_get(&state, request).await?).unwrap()))
}

async fn task_pull_merge(
    State(state): State<AppState>,
    Json(request): Json<TaskPullMergeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::pull_merge(&state, request).await?).unwrap()))
}

async fn task_default_sync(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::to_value(task_lifecycle::default_sync(&state, request).await?).unwrap()))
}
