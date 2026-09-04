use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

const MAX_CONVERSATION_ID_BYTES: usize = 128;
const MAX_CLIENT_REQUEST_ID_BYTES: usize = 128;
const MAX_WORKSPACES: usize = 64;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ConversationContextRequest {
    pub operation: String,
    pub conversation_id: Option<String>,
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct ConversationContextView {
    pub id: String,
    pub workspaces: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ConversationContextResult {
    pub conversation: ConversationContextView,
    pub replayed: bool,
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn validate_conversation_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_CONVERSATION_ID_BYTES
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return Err(AppError::InvalidRequest(
            "conversation_id must be 1-128 printable ASCII characters".into(),
        ));
    }
    Ok(())
}

fn validate_client_request_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_CLIENT_REQUEST_ID_BYTES
        || !value.is_ascii()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AppError::InvalidRequest(format!(
            "client_request_id must be 1-{MAX_CLIENT_REQUEST_ID_BYTES} ASCII bytes using letters, digits, '-', '_', '.', or ':'"
        )));
    }
    Ok(())
}

fn normalized_workspaces(state: &AppState, values: &[String]) -> AppResult<Vec<String>> {
    if values.len() > MAX_WORKSPACES {
        return Err(AppError::InvalidRequest(format!(
            "conversation workspace list exceeds {MAX_WORKSPACES} entries"
        )));
    }
    let mut workspaces = values.to_vec();
    workspaces.sort();
    workspaces.dedup();
    for workspace in &workspaces {
        state.workspaces.get(workspace)?;
    }
    Ok(workspaces)
}

async fn ensure_owner(
    state: &AppState,
    conversation_id: &str,
    principal_id: &str,
    operator: bool,
) -> AppResult<(i64, i64)> {
    validate_conversation_id(conversation_id)?;
    let row: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT principal_id, created_at, updated_at FROM conversation_contexts WHERE id=?1",
    )
    .bind(conversation_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((owner, created_at, updated_at)) = row else {
        return Err(AppError::InvalidRequest(format!(
            "conversation context not found: {conversation_id}"
        )));
    };
    if !operator && owner != principal_id {
        return Err(AppError::InvalidRequest(format!(
            "conversation context not found: {conversation_id}"
        )));
    }
    Ok((created_at, updated_at))
}

async fn view(
    state: &AppState,
    conversation_id: &str,
    principal_id: &str,
    operator: bool,
) -> AppResult<ConversationContextView> {
    let (created_at, updated_at) =
        ensure_owner(state, conversation_id, principal_id, operator).await?;
    let workspaces: Vec<String> = sqlx::query_scalar(
        "SELECT workspace_id FROM conversation_workspaces WHERE conversation_id=?1 ORDER BY workspace_id",
    )
    .bind(conversation_id)
    .fetch_all(&state.db)
    .await?;
    Ok(ConversationContextView {
        id: conversation_id.to_string(),
        workspaces,
        created_at,
        updated_at,
    })
}

async fn open(
    state: &AppState,
    req: &ConversationContextRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<ConversationContextResult> {
    if req.conversation_id.is_some() {
        return Err(AppError::InvalidRequest(
            "conversation context open does not accept conversation_id".into(),
        ));
    }
    let workspaces = normalized_workspaces(state, &req.workspaces)?;
    let fingerprint = sha256(
        serde_json::to_vec(&("conversation-open-v1", &workspaces)).map_err(anyhow::Error::from)?,
    );
    if let Some(client_request_id) = req.client_request_id.as_deref() {
        validate_client_request_id(client_request_id)?;
        let existing: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM conversation_contexts WHERE principal_id=?1 AND client_request_id=?2",
        )
        .bind(principal_id)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((id, existing_fingerprint)) = existing {
            if existing_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                return Err(AppError::InvalidRequest(
                    "client_request_id already exists with a different conversation context request"
                        .into(),
                ));
            }
            return Ok(ConversationContextResult {
                conversation: view(state, &id, principal_id, operator).await?,
                replayed: true,
            });
        }
    }

    let id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO conversation_contexts(id, principal_id, client_request_id, request_fingerprint, created_at, updated_at) \
         VALUES(?1, ?2, ?3, ?4, unixepoch(), unixepoch())",
    )
    .bind(&id)
    .bind(principal_id)
    .bind(req.client_request_id.as_deref())
    .bind(&fingerprint)
    .execute(&mut *tx)
    .await?;
    for workspace in &workspaces {
        sqlx::query(
            "INSERT INTO conversation_workspaces(conversation_id, workspace_id, attached_at) VALUES(?1, ?2, unixepoch())",
        )
        .bind(&id)
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(ConversationContextResult {
        conversation: view(state, &id, principal_id, operator).await?,
        replayed: false,
    })
}

async fn mutate_bindings(
    state: &AppState,
    req: &ConversationContextRequest,
    principal_id: &str,
    operator: bool,
    attach: bool,
) -> AppResult<ConversationContextResult> {
    if req.client_request_id.is_some() {
        return Err(AppError::InvalidRequest(
            "conversation attach/detach does not accept client_request_id".into(),
        ));
    }
    let conversation_id = req.conversation_id.as_deref().ok_or_else(|| {
        AppError::InvalidRequest("conversation attach/detach requires conversation_id".into())
    })?;
    ensure_owner(state, conversation_id, principal_id, operator).await?;
    let workspaces = normalized_workspaces(state, &req.workspaces)?;
    if workspaces.is_empty() {
        return Err(AppError::InvalidRequest(
            "conversation attach/detach requires at least one workspace".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    for workspace in &workspaces {
        if attach {
            sqlx::query(
                "INSERT OR IGNORE INTO conversation_workspaces(conversation_id, workspace_id, attached_at) VALUES(?1, ?2, unixepoch())",
            )
            .bind(conversation_id)
            .bind(workspace)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                "DELETE FROM conversation_workspaces WHERE conversation_id=?1 AND workspace_id=?2",
            )
            .bind(conversation_id)
            .bind(workspace)
            .execute(&mut *tx)
            .await?;
        }
    }
    sqlx::query("UPDATE conversation_contexts SET updated_at=unixepoch() WHERE id=?1")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ConversationContextResult {
        conversation: view(state, conversation_id, principal_id, operator).await?,
        replayed: false,
    })
}

pub async fn apply(
    state: &AppState,
    req: ConversationContextRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<ConversationContextResult> {
    match req.operation.as_str() {
        "open" => open(state, &req, principal_id, operator).await,
        "get" => {
            if req.client_request_id.is_some() || !req.workspaces.is_empty() {
                return Err(AppError::InvalidRequest(
                    "conversation get accepts only conversation_id".into(),
                ));
            }
            let conversation_id = req.conversation_id.as_deref().ok_or_else(|| {
                AppError::InvalidRequest("conversation get requires conversation_id".into())
            })?;
            Ok(ConversationContextResult {
                conversation: view(state, conversation_id, principal_id, operator).await?,
                replayed: false,
            })
        }
        "attach" => mutate_bindings(state, &req, principal_id, operator, true).await,
        "detach" => mutate_bindings(state, &req, principal_id, operator, false).await,
        _ => Err(AppError::InvalidRequest(
            "conversation operation must be one of open, get, attach, detach".into(),
        )),
    }
}

pub async fn ensure_workspace_bound(
    state: &AppState,
    conversation_id: &str,
    principal_id: &str,
    operator: bool,
    workspace: &str,
) -> AppResult<()> {
    state.workspaces.get(workspace)?;
    ensure_owner(state, conversation_id, principal_id, operator).await?;
    let bound: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_workspaces WHERE conversation_id=?1 AND workspace_id=?2",
    )
    .bind(conversation_id)
    .bind(workspace)
    .fetch_one(&state.db)
    .await?;
    if bound == 0 {
        return Err(AppError::InvalidRequest(format!(
            "workspace `{workspace}` is not attached to conversation `{conversation_id}`"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Mutex;

    use super::*;
    use crate::{config::WorkspaceConfig, db, workspace::WorkspaceRegistry};

    async fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().expect("conversation fixture");
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir_all(a.join(".git")).expect("workspace a");
        std::fs::create_dir_all(b.join(".git")).expect("workspace b");
        let registry = WorkspaceRegistry::build(&[
            WorkspaceConfig {
                id: "a".into(),
                name: "A".into(),
                root: a,
                access: "read-write".into(),
                remote: "origin".into(),
                default_branch: "main".into(),
                provider: None,
                repository: None,
                github_repository: None,
            },
            WorkspaceConfig {
                id: "b".into(),
                name: "B".into(),
                root: b,
                access: "read-write".into(),
                remote: "origin".into(),
                default_branch: "main".into(),
                provider: None,
                repository: None,
                github_repository: None,
            },
        ])
        .expect("workspace registry");
        let pool = db::connect(&root.path().join("state"))
            .await
            .expect("conversation db");
        db::register_workspaces(&pool, &registry)
            .await
            .expect("register workspaces");
        (
            root,
            AppState {
                workspaces: registry,
                db: pool,
                mutation_lock: Arc::new(Mutex::new(())),
                github_token: None,
            },
        )
    }

    #[tokio::test]
    async fn conversation_workspace_binding_is_many_to_many() {
        let (_root, state) = fixture().await;
        let first = apply(
            &state,
            ConversationContextRequest {
                operation: "open".into(),
                conversation_id: None,
                client_request_id: Some("conversation:first".into()),
                workspaces: vec!["a".into(), "b".into()],
            },
            "principal",
            false,
        )
        .await
        .expect("first conversation");
        assert_eq!(first.conversation.workspaces, vec!["a", "b"]);

        let second = apply(
            &state,
            ConversationContextRequest {
                operation: "open".into(),
                conversation_id: None,
                client_request_id: Some("conversation:second".into()),
                workspaces: vec!["a".into()],
            },
            "principal",
            false,
        )
        .await
        .expect("second conversation");
        assert_ne!(first.conversation.id, second.conversation.id);
        ensure_workspace_bound(&state, &second.conversation.id, "principal", false, "a")
            .await
            .expect("workspace a shared by second conversation");

        let detached = apply(
            &state,
            ConversationContextRequest {
                operation: "detach".into(),
                conversation_id: Some(first.conversation.id.clone()),
                client_request_id: None,
                workspaces: vec!["a".into()],
            },
            "principal",
            false,
        )
        .await
        .expect("detach first edge");
        assert_eq!(detached.conversation.workspaces, vec!["b"]);
        ensure_workspace_bound(&state, &second.conversation.id, "principal", false, "a")
            .await
            .expect("second conversation edge remains");
    }
}
