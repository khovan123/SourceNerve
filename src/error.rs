use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("workspace not found: {0}")]
    WorkspaceNotFound(String),
    #[error("path is outside the configured workspace")]
    PathOutsideWorkspace,
    #[error("workspace is read-only")]
    ReadOnlyWorkspace,
    #[error("workspace changed: expected HEAD {expected}, current HEAD {actual}")]
    WorkspaceChanged { expected: String, actual: String },
    #[error("file changed since it was read: {path}")]
    FileChanged { path: String },
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("command failed: {0}")]
    Command(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::WorkspaceNotFound(_) => StatusCode::NOT_FOUND,
            Self::PathOutsideWorkspace | Self::ReadOnlyWorkspace => StatusCode::FORBIDDEN,
            Self::WorkspaceChanged { .. } | Self::FileChanged { .. } => StatusCode::CONFLICT,
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::Command(_) | Self::Io(_) | Self::Sqlx(_) | Self::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
