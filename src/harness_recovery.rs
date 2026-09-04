use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

use super::{HarnessRunRow, WorkspaceSnapshot};

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessCheckpointView {
    pub id: String,
    pub event_seq: i64,
    pub state: String,
    pub reason: String,
    pub facts_sha256: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessRunRecovery {
    pub state: String,
    pub reason: String,
    pub pending_approvals: i64,
    pub active_jobs: i64,
    pub uncertain_mutations: i64,
    pub retryable_read_executions: i64,
    pub retryable_pre_dispatch_executions: i64,
    pub blocked_pre_dispatch_executions: i64,
    pub checkpoint: Option<HarnessCheckpointView>,
}

#[derive(Debug, Clone, Serialize)]
struct RecoveryFacts {
    workspace: String,
    profile: String,
    run_status: String,
    freshness_state: String,
    freshness_reason: Option<String>,
    base_head: String,
    current_head: String,
    run_capability_snapshot_sha256: String,
    current_capability_snapshot_sha256: String,
    pending_approvals: i64,
    active_jobs: i64,
    uncertain_mutations: i64,
    retryable_read_executions: i64,
    retryable_pre_dispatch_executions: i64,
    blocked_pre_dispatch_executions: i64,
    blocker_kind: Option<String>,
    blocker_id: Option<String>,
    blocker_tool: Option<String>,
}

type CheckpointDbRow = (String, i64, String, String, String, i64);

fn checkpoint_view(row: CheckpointDbRow) -> HarnessCheckpointView {
    HarnessCheckpointView {
        id: row.0,
        event_seq: row.1,
        state: row.2,
        reason: row.3,
        facts_sha256: row.4,
        created_at: row.5,
    }
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

async fn count_scalar(state: &AppState, sql: &str, run_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar(sql)
        .bind(run_id)
        .fetch_one(&state.db)
        .await?)
}

async fn first_execution(
    state: &AppState,
    run_id: &str,
    predicate: &str,
) -> AppResult<Option<(String, String)>> {
    let sql = format!(
        "SELECT id, tool_name FROM harness_tool_executions \
         WHERE run_id=?1 AND {predicate} ORDER BY started_at, id LIMIT 1"
    );
    Ok(sqlx::query_as(&sql)
        .bind(run_id)
        .fetch_optional(&state.db)
        .await?)
}

async fn first_pending_approval(
    state: &AppState,
    run_id: &str,
) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT id, tool_name FROM harness_approvals \
         WHERE run_id=?1 AND status='pending' AND expires_at > unixepoch() \
         ORDER BY requested_at, id LIMIT 1",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?)
}

async fn load_matching_checkpoint(
    state: &AppState,
    run_id: &str,
    facts_sha256: &str,
) -> AppResult<Option<HarnessCheckpointView>> {
    let row: Option<CheckpointDbRow> = sqlx::query_as(
        "SELECT id, event_seq, state, reason, facts_sha256, created_at \
         FROM harness_checkpoints WHERE run_id=?1 AND facts_sha256=?2 LIMIT 1",
    )
    .bind(run_id)
    .bind(facts_sha256)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(checkpoint_view))
}

async fn persist_checkpoint(
    state: &AppState,
    row: &HarnessRunRow,
    recovery_state: &str,
    reason: &str,
    facts_json: &str,
    facts_sha256: &str,
) -> AppResult<HarnessCheckpointView> {
    if let Some(existing) = load_matching_checkpoint(state, &row.id, facts_sha256).await? {
        return Ok(existing);
    }

    let _guard = state.mutation_lock.lock().await;
    if let Some(existing) = load_matching_checkpoint(state, &row.id, facts_sha256).await? {
        return Ok(existing);
    }

    let checkpoint_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    let event_seq = super::append_event_tx(
        &mut tx,
        &row.id,
        "checkpoint/created",
        &serde_json::json!({
            "checkpoint_id": checkpoint_id,
            "state": recovery_state,
            "reason": reason,
            "facts_sha256": facts_sha256,
        }),
    )
    .await?;
    sqlx::query(
        "INSERT INTO harness_checkpoints(\
            id, run_id, event_seq, state, reason, facts_json, facts_sha256, created_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())",
    )
    .bind(&checkpoint_id)
    .bind(&row.id)
    .bind(event_seq)
    .bind(recovery_state)
    .bind(reason)
    .bind(facts_json)
    .bind(facts_sha256)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    load_matching_checkpoint(state, &row.id, facts_sha256)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Harness checkpoint disappeared")))
}

pub(super) async fn inspect(
    state: &AppState,
    row: &HarnessRunRow,
    current: &WorkspaceSnapshot,
    persist: bool,
) -> AppResult<HarnessRunRecovery> {
    let freshness = super::freshness(row, current);
    let run_id = row.id.as_str();

    let pending_approvals = count_scalar(
        state,
        "SELECT COUNT(*) FROM harness_approvals \
         WHERE run_id=?1 AND status='pending' AND expires_at > unixepoch()",
        run_id,
    )
    .await?;
    let active_jobs = count_scalar(
        state,
        "SELECT COUNT(*) FROM jobs j \
         WHERE j.harness_run_id=?1 \
           AND NOT EXISTS (\
               SELECT 1 FROM job_events e \
               WHERE e.job_id=j.id \
                 AND e.event_type IN ('job_completed', 'job_cancelled', 'job_failed')\
           )",
        run_id,
    )
    .await?;
    let uncertain_mutations = count_scalar(
        state,
        "SELECT COUNT(*) FROM harness_tool_executions \
         WHERE run_id=?1 AND dispatched=1 AND completed_at IS NULL AND read_only=0",
        run_id,
    )
    .await?;
    let retryable_read_executions = count_scalar(
        state,
        "SELECT COUNT(*) FROM harness_tool_executions \
         WHERE run_id=?1 AND dispatched=1 AND completed_at IS NULL AND read_only=1",
        run_id,
    )
    .await?;
    let retryable_pre_dispatch_executions = count_scalar(
        state,
        "SELECT COUNT(*) FROM harness_tool_executions \
         WHERE run_id=?1 AND dispatched=0 AND completed_at IS NULL \
           AND result_category='started' AND idempotent=1",
        run_id,
    )
    .await?;
    let blocked_pre_dispatch_executions = count_scalar(
        state,
        "SELECT COUNT(*) FROM harness_tool_executions \
         WHERE run_id=?1 AND dispatched=0 AND completed_at IS NULL \
           AND result_category='started' AND idempotent=0",
        run_id,
    )
    .await?;

    let uncertain = first_execution(
        state,
        run_id,
        "dispatched=1 AND completed_at IS NULL AND read_only=0",
    )
    .await?;
    let blocked_pre_dispatch = first_execution(
        state,
        run_id,
        "dispatched=0 AND completed_at IS NULL AND result_category='started' AND idempotent=0",
    )
    .await?;
    let pending = first_pending_approval(state, run_id).await?;

    let (recovery_state, reason, blocker_kind, blocker_id, blocker_tool) =
        if matches!(row.status.as_str(), "completed" | "cancelled" | "failed") {
            ("terminal", format!("run_{}", row.status), None, None, None)
        } else if row.status == "stale" || freshness.state == "stale" {
            (
                "stale",
                freshness
                    .reason
                    .clone()
                    .unwrap_or_else(|| "run_stale".to_string()),
                None,
                None,
                None,
            )
        } else if let Some((id, tool)) = uncertain {
            (
                "requires-review",
                "post_dispatch_mutation_uncertain".to_string(),
                Some("execution".to_string()),
                Some(id),
                Some(tool),
            )
        } else if let Some((id, tool)) = blocked_pre_dispatch {
            (
                "requires-review",
                "non_idempotent_pre_dispatch".to_string(),
                Some("execution".to_string()),
                Some(id),
                Some(tool),
            )
        } else if let Some((id, tool)) = pending {
            (
                "requires-review",
                "approval_pending".to_string(),
                Some("approval".to_string()),
                Some(id),
                Some(tool),
            )
        } else if active_jobs > 0 {
            (
                "resumable",
                "reconcile_active_jobs".to_string(),
                None,
                None,
                None,
            )
        } else if retryable_read_executions > 0 || retryable_pre_dispatch_executions > 0 {
            (
                "resumable",
                "safe_retry_available".to_string(),
                None,
                None,
                None,
            )
        } else {
            ("resumable", "ready".to_string(), None, None, None)
        };

    let facts = RecoveryFacts {
        workspace: row.workspace.clone(),
        profile: row.profile.clone(),
        run_status: row.status.clone(),
        freshness_state: freshness.state.clone(),
        freshness_reason: freshness.reason.clone(),
        base_head: row.base_head.clone(),
        current_head: current.head.clone(),
        run_capability_snapshot_sha256: row.capability_snapshot_sha256.clone(),
        current_capability_snapshot_sha256: current.capability_snapshot_sha256.clone(),
        pending_approvals,
        active_jobs,
        uncertain_mutations,
        retryable_read_executions,
        retryable_pre_dispatch_executions,
        blocked_pre_dispatch_executions,
        blocker_kind,
        blocker_id,
        blocker_tool,
    };
    let facts_json = serde_json::to_string(&facts).map_err(anyhow::Error::from)?;
    let digest = sha256(
        serde_json::to_vec(&(recovery_state, reason.as_str(), &facts))
            .map_err(anyhow::Error::from)?,
    );
    let checkpoint = if persist {
        Some(persist_checkpoint(state, row, recovery_state, &reason, &facts_json, &digest).await?)
    } else {
        load_matching_checkpoint(state, run_id, &digest).await?
    };

    Ok(HarnessRunRecovery {
        state: recovery_state.to_string(),
        reason,
        pending_approvals,
        active_jobs,
        uncertain_mutations,
        retryable_read_executions,
        retryable_pre_dispatch_executions,
        blocked_pre_dispatch_executions,
        checkpoint,
    })
}
