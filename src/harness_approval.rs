use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

pub const APPROVAL_TTL_SECONDS: i64 = 5 * 60;
const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 200;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessApprovalListRequest {
    pub run_id: String,
    pub status: Option<String>,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessApprovalRespondRequest {
    pub approval_id: String,
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessApprovalView {
    pub id: String,
    pub run_id: String,
    pub principal_id: String,
    pub workspace: String,
    pub tool: String,
    pub capability_id: String,
    pub argument_sha256: String,
    pub head_sha: String,
    pub policy: String,
    pub status: String,
    pub requested_execution_id: Option<String>,
    pub requested_at: i64,
    pub expires_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_by: Option<String>,
    pub consumed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessApprovalListResult {
    pub run_id: String,
    pub approvals: Vec<HarnessApprovalView>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessApprovalRespondResult {
    pub approval: HarnessApprovalView,
    pub replayed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ApprovalIntent {
    pub run_id: String,
    pub principal_id: String,
    pub workspace: String,
    pub tool: String,
    pub capability_id: String,
    pub argument_sha256: String,
    pub head_sha: String,
}

type ApprovalDbRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<i64>,
);

fn default_list_limit() -> usize {
    DEFAULT_LIST_LIMIT
}

fn row_to_view(row: ApprovalDbRow) -> HarnessApprovalView {
    HarnessApprovalView {
        id: row.0,
        run_id: row.1,
        principal_id: row.2,
        workspace: row.3,
        tool: row.4,
        capability_id: row.5,
        argument_sha256: row.6,
        head_sha: row.7,
        policy: row.8,
        status: row.9,
        requested_execution_id: row.10,
        requested_at: row.11,
        expires_at: row.12,
        resolved_at: row.13,
        resolved_by: row.14,
        consumed_at: row.15,
    }
}

fn validate_status(status: &str) -> AppResult<()> {
    if matches!(
        status,
        "pending" | "allowed" | "denied" | "consumed" | "expired"
    ) {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "unsupported harness approval status `{status}`"
        )))
    }
}

fn decision_status(decision: &str) -> AppResult<&'static str> {
    match decision {
        "allow" => Ok("allowed"),
        "deny" => Ok("denied"),
        other => Err(AppError::InvalidRequest(format!(
            "unsupported harness approval decision `{other}`; expected allow or deny"
        ))),
    }
}

async fn append_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    let payload_json = serde_json::to_string(payload).map_err(anyhow::Error::from)?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE harness_runs SET next_event_seq=next_event_seq+1, updated_at=unixepoch() \
         WHERE id=?1 RETURNING next_event_seq-1",
    )
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO harness_events(run_id, seq, event_type, payload_json, created_at) \
         VALUES(?1, ?2, ?3, ?4, unixepoch())",
    )
    .bind(run_id)
    .bind(seq)
    .bind(event_type)
    .bind(payload_json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn expire_for_run(state: &AppState, run_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE harness_approvals SET status='expired', resolved_at=COALESCE(resolved_at, unixepoch()) \
         WHERE run_id=?1 AND status IN ('pending', 'allowed') AND expires_at <= unixepoch()",
    )
    .bind(run_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn load(state: &AppState, approval_id: &str) -> AppResult<HarnessApprovalView> {
    let row: Option<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at \
         FROM harness_approvals WHERE id=?1",
    )
    .bind(approval_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(row_to_view).ok_or_else(|| {
        AppError::InvalidRequest(format!("harness approval not found: {approval_id}"))
    })
}

fn ensure_owner(
    approval: &HarnessApprovalView,
    principal_id: &str,
    operator: bool,
) -> AppResult<()> {
    if operator || approval.principal_id == principal_id {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "harness approval not found: {}",
            approval.id
        )))
    }
}

pub(crate) async fn request_pending(
    state: &AppState,
    intent: &ApprovalIntent,
    execution_id: &str,
) -> AppResult<(HarnessApprovalView, bool)> {
    expire_for_run(state, &intent.run_id).await?;
    let existing: Option<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at \
         FROM harness_approvals \
         WHERE run_id=?1 AND principal_id=?2 AND workspace_id=?3 AND tool_name=?4 \
           AND capability_id=?5 AND argument_sha256=?6 AND head_sha=?7 \
           AND status='pending' AND expires_at > unixepoch() \
         ORDER BY requested_at DESC, id DESC LIMIT 1",
    )
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .fetch_optional(&state.db)
    .await?;
    if let Some(row) = existing {
        return Ok((row_to_view(row), false));
    }

    let id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_approvals(\
            id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
            head_sha, policy, status, requested_execution_id, expires_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ask', 'pending', ?9, unixepoch()+?10)",
    )
    .bind(&id)
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .bind(execution_id)
    .bind(APPROVAL_TTL_SECONDS)
    .execute(&mut *tx)
    .await?;
    append_event_tx(
        &mut tx,
        &intent.run_id,
        "approval/requested",
        &serde_json::json!({
            "approval_id": id,
            "execution_id": execution_id,
            "tool": intent.tool,
            "capability_id": intent.capability_id,
            "argument_sha256": intent.argument_sha256,
            "workspace": intent.workspace,
            "head_sha": intent.head_sha,
            "expires_in_seconds": APPROVAL_TTL_SECONDS,
        }),
    )
    .await?;
    tx.commit().await?;
    Ok((load(state, &id).await?, true))
}

pub(crate) async fn consume_matching(
    state: &AppState,
    intent: &ApprovalIntent,
) -> AppResult<Option<String>> {
    expire_for_run(state, &intent.run_id).await?;
    let candidate: Option<String> = sqlx::query_scalar(
        "SELECT id FROM harness_approvals \
         WHERE run_id=?1 AND principal_id=?2 AND workspace_id=?3 AND tool_name=?4 \
           AND capability_id=?5 AND argument_sha256=?6 AND head_sha=?7 \
           AND status='allowed' AND expires_at > unixepoch() \
         ORDER BY resolved_at DESC, id DESC LIMIT 1",
    )
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .fetch_optional(&state.db)
    .await?;
    let Some(id) = candidate else {
        return Ok(None);
    };
    let result = sqlx::query(
        "UPDATE harness_approvals SET status='consumed', consumed_at=unixepoch() \
         WHERE id=?1 AND status='allowed' AND expires_at > unixepoch()",
    )
    .bind(&id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 1 {
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

pub async fn list(
    state: &AppState,
    request: HarnessApprovalListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessApprovalListResult> {
    if request.limit == 0 || request.limit > MAX_LIST_LIMIT {
        return Err(AppError::InvalidRequest(format!(
            "harness approval list limit must be 1-{MAX_LIST_LIMIT}"
        )));
    }
    if let Some(status) = request.status.as_deref() {
        validate_status(status)?;
    }
    let owner: Option<String> =
        sqlx::query_scalar("SELECT principal_id FROM harness_runs WHERE id=?1")
            .bind(&request.run_id)
            .fetch_optional(&state.db)
            .await?;
    let owner = owner.ok_or_else(|| {
        AppError::InvalidRequest(format!("harness run not found: {}", request.run_id))
    })?;
    if !operator && owner != principal_id {
        return Err(AppError::InvalidRequest(format!(
            "harness run not found: {}",
            request.run_id
        )));
    }
    expire_for_run(state, &request.run_id).await?;
    let rows: Vec<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at \
         FROM harness_approvals \
         WHERE run_id=?1 AND (?2 IS NULL OR status=?2) \
         ORDER BY requested_at DESC, id DESC LIMIT ?3",
    )
    .bind(&request.run_id)
    .bind(request.status.as_deref())
    .bind(request.limit as i64)
    .fetch_all(&state.db)
    .await?;
    Ok(HarnessApprovalListResult {
        run_id: request.run_id,
        approvals: rows.into_iter().map(row_to_view).collect(),
    })
}

pub async fn respond(
    state: &AppState,
    request: HarnessApprovalRespondRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessApprovalRespondResult> {
    let target_status = decision_status(&request.decision)?;
    let mut approval = load(state, &request.approval_id).await?;
    ensure_owner(&approval, principal_id, operator)?;
    expire_for_run(state, &approval.run_id).await?;
    approval = load(state, &request.approval_id).await?;
    ensure_owner(&approval, principal_id, operator)?;

    if approval.status == target_status {
        return Ok(HarnessApprovalRespondResult {
            approval,
            replayed: true,
        });
    }
    if approval.status == "expired" {
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} has expired",
            approval.id
        )));
    }
    if approval.status != "pending" {
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} is already {}",
            approval.id, approval.status
        )));
    }

    let resolver = if operator {
        "operator".to_string()
    } else {
        principal_id.to_string()
    };
    let mut tx = state.db.begin().await?;
    let result = sqlx::query(
        "UPDATE harness_approvals SET status=?1, resolved_by=?2, resolved_at=unixepoch() \
         WHERE id=?3 AND status='pending' AND expires_at > unixepoch()",
    )
    .bind(target_status)
    .bind(&resolver)
    .bind(&approval.id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        tx.rollback().await?;
        expire_for_run(state, &approval.run_id).await?;
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} is no longer pending",
            approval.id
        )));
    }
    append_event_tx(
        &mut tx,
        &approval.run_id,
        "approval/resolved",
        &serde_json::json!({
            "approval_id": approval.id,
            "tool": approval.tool,
            "capability_id": approval.capability_id,
            "argument_sha256": approval.argument_sha256,
            "workspace": approval.workspace,
            "head_sha": approval.head_sha,
            "decision": request.decision,
            "resolved_by": resolver,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(HarnessApprovalRespondResult {
        approval: load(state, &request.approval_id).await?,
        replayed: false,
    })
}
