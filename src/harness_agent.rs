use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

use super::HarnessRunIdRequest;

const DEFAULT_MAX_ITERATIONS: usize = 12;
const MAX_ITERATIONS: usize = 64;
const DEFAULT_LIST_LIMIT: usize = 25;
const MAX_LIST_LIMIT: usize = 100;
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 128;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentTurnBeginRequest {
    pub run_id: String,
    pub client_request_id: Option<String>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentTurnIdRequest {
    pub turn_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentTurnListRequest {
    pub run_id: String,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentTurnIterationRequest {
    pub turn_id: String,
    pub iteration: usize,
    pub decision: String,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentTurnCompleteRequest {
    pub turn_id: String,
    pub status: String,
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessAgentTurnView {
    pub id: String,
    pub run_id: String,
    pub client_request_id: Option<String>,
    pub status: String,
    pub max_iterations: usize,
    pub iteration_count: usize,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub stop_reason: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub started_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessAgentTurnBeginResult {
    pub turn: HarnessAgentTurnView,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessAgentTurnListResult {
    pub turns: Vec<HarnessAgentTurnView>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessAgentTurnIterationResult {
    pub turn: HarnessAgentTurnView,
    pub iteration_limit_reached: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct TurnRow {
    id: String,
    run_id: String,
    client_request_id: Option<String>,
    request_fingerprint: Option<String>,
    status: String,
    max_iterations: i64,
    iteration_count: i64,
    provider_id: Option<String>,
    model_id: Option<String>,
    stop_reason: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    started_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

fn default_max_iterations() -> usize {
    DEFAULT_MAX_ITERATIONS
}

fn default_list_limit() -> usize {
    DEFAULT_LIST_LIMIT
}

fn bounded_optional(value: &Option<String>, max: usize, label: &str) -> AppResult<()> {
    if let Some(value) = value {
        if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
            return Err(AppError::InvalidRequest(format!(
                "{label} must be 1-{max} non-control UTF-8 bytes"
            )));
        }
    }
    Ok(())
}

fn validate_decision(decision: &str, tool_name: &Option<String>) -> AppResult<()> {
    if !matches!(decision, "reply" | "tool" | "stop") {
        return Err(AppError::InvalidRequest(
            "agent decision must be reply, tool, or stop".into(),
        ));
    }
    bounded_optional(tool_name, MAX_TOOL_NAME_BYTES, "agent tool_name")?;
    if decision == "tool" && tool_name.is_none() {
        return Err(AppError::InvalidRequest(
            "agent tool decision requires tool_name".into(),
        ));
    }
    if decision != "tool" && tool_name.is_some() {
        return Err(AppError::InvalidRequest(
            "agent tool_name is only valid for tool decisions".into(),
        ));
    }
    Ok(())
}

fn validate_terminal(status: &str, stop_reason: &Option<String>) -> AppResult<()> {
    if !matches!(
        status,
        "completed" | "failed" | "cancelled" | "iteration-limit"
    ) {
        return Err(AppError::InvalidRequest(
            "agent terminal status must be completed, failed, cancelled, or iteration-limit".into(),
        ));
    }
    if let Some(reason) = stop_reason {
        if !matches!(
            reason.as_str(),
            "model-reply" | "no-tool" | "iteration-limit" | "cancelled" | "error"
        ) {
            return Err(AppError::InvalidRequest(
                "agent stop_reason is not allowlisted".into(),
            ));
        }
    }
    Ok(())
}

fn turn_view(row: TurnRow) -> AppResult<HarnessAgentTurnView> {
    Ok(HarnessAgentTurnView {
        id: row.id,
        run_id: row.run_id,
        client_request_id: row.client_request_id,
        status: row.status,
        max_iterations: usize::try_from(row.max_iterations).map_err(|_| {
            AppError::InvalidRequest("stored agent max_iterations is invalid".into())
        })?,
        iteration_count: usize::try_from(row.iteration_count).map_err(|_| {
            AppError::InvalidRequest("stored agent iteration_count is invalid".into())
        })?,
        provider_id: row.provider_id,
        model_id: row.model_id,
        stop_reason: row.stop_reason,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        started_at: row.started_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
    })
}

async fn load_turn(state: &AppState, turn_id: &str) -> AppResult<TurnRow> {
    if turn_id.is_empty() || turn_id.len() > 128 || turn_id.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest("agent turn_id is invalid".into()));
    }
    sqlx::query_as::<_, TurnRow>(
        "SELECT id, run_id, client_request_id, request_fingerprint, status, max_iterations, \
                iteration_count, provider_id, model_id, stop_reason, input_tokens, output_tokens, \
                started_at, updated_at, completed_at \
         FROM harness_agent_turns WHERE id=?1",
    )
    .bind(turn_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::InvalidRequest(format!("agent turn not found: {turn_id}")))
}

async fn authorize_turn(
    state: &AppState,
    row: &TurnRow,
    principal_id: &str,
    operator: bool,
) -> AppResult<()> {
    super::get(
        state,
        HarnessRunIdRequest {
            run_id: row.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    Ok(())
}

pub async fn begin(
    state: &AppState,
    request: HarnessAgentTurnBeginRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentTurnBeginResult> {
    if request.max_iterations == 0 || request.max_iterations > MAX_ITERATIONS {
        return Err(AppError::InvalidRequest(format!(
            "agent max_iterations must be 1-{MAX_ITERATIONS}"
        )));
    }
    bounded_optional(
        &request.provider_id,
        MAX_PROVIDER_ID_BYTES,
        "agent provider_id",
    )?;
    bounded_optional(&request.model_id, MAX_MODEL_ID_BYTES, "agent model_id")?;
    if let Some(value) = request.client_request_id.as_deref() {
        super::validate_client_request_id(value)?;
    }

    let run = super::get(
        state,
        HarnessRunIdRequest {
            run_id: request.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    if run.run.status != "running" || run.freshness.state != "current" {
        return Err(AppError::InvalidRequest(
            "agent turn requires a current running Harness run".into(),
        ));
    }

    let fingerprint = super::sha256(
        serde_json::to_vec(&(
            "agent-turn-v1",
            &request.run_id,
            request.max_iterations,
            &request.provider_id,
            &request.model_id,
        ))
        .map_err(anyhow::Error::from)?,
    );

    if let Some(client_request_id) = request.client_request_id.as_deref() {
        let existing = sqlx::query_as::<_, TurnRow>(
            "SELECT id, run_id, client_request_id, request_fingerprint, status, max_iterations, \
                    iteration_count, provider_id, model_id, stop_reason, input_tokens, output_tokens, \
                    started_at, updated_at, completed_at \
             FROM harness_agent_turns WHERE run_id=?1 AND client_request_id=?2",
        )
        .bind(&request.run_id)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(existing) = existing {
            if existing.request_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                return Err(AppError::InvalidRequest(
                    "agent client_request_id was already used with different arguments".into(),
                ));
            }
            return Ok(HarnessAgentTurnBeginResult {
                turn: turn_view(existing)?,
                replayed: true,
            });
        }
    }

    let id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_agent_turns( \
             id, run_id, client_request_id, request_fingerprint, status, max_iterations, \
             provider_id, model_id, started_at, updated_at \
         ) VALUES(?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, unixepoch(), unixepoch())",
    )
    .bind(&id)
    .bind(&request.run_id)
    .bind(&request.client_request_id)
    .bind(&fingerprint)
    .bind(i64::try_from(request.max_iterations).unwrap_or(i64::MAX))
    .bind(&request.provider_id)
    .bind(&request.model_id)
    .execute(&mut *tx)
    .await?;
    super::append_event_tx(
        &mut tx,
        &request.run_id,
        "agent/turn_started",
        &serde_json::json!({
            "turn_id": id,
            "max_iterations": request.max_iterations,
            "provider_id": request.provider_id,
            "model_id": request.model_id,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(HarnessAgentTurnBeginResult {
        turn: turn_view(load_turn(state, &id).await?)?,
        replayed: false,
    })
}

pub async fn get(
    state: &AppState,
    request: HarnessAgentTurnIdRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentTurnView> {
    let row = load_turn(state, &request.turn_id).await?;
    authorize_turn(state, &row, principal_id, operator).await?;
    turn_view(row)
}

pub async fn list(
    state: &AppState,
    request: HarnessAgentTurnListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentTurnListResult> {
    super::get(
        state,
        HarnessRunIdRequest {
            run_id: request.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    let limit = request.limit.clamp(1, MAX_LIST_LIMIT) as i64;
    let rows = sqlx::query_as::<_, TurnRow>(
        "SELECT id, run_id, client_request_id, request_fingerprint, status, max_iterations, \
                iteration_count, provider_id, model_id, stop_reason, input_tokens, output_tokens, \
                started_at, updated_at, completed_at \
         FROM harness_agent_turns WHERE run_id=?1 \
         ORDER BY updated_at DESC, started_at DESC LIMIT ?2",
    )
    .bind(&request.run_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(HarnessAgentTurnListResult {
        turns: rows
            .into_iter()
            .map(turn_view)
            .collect::<AppResult<Vec<_>>>()?,
    })
}

pub async fn record_iteration(
    state: &AppState,
    request: HarnessAgentTurnIterationRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentTurnIterationResult> {
    validate_decision(&request.decision, &request.tool_name)?;
    let row = load_turn(state, &request.turn_id).await?;
    authorize_turn(state, &row, principal_id, operator).await?;
    if row.status != "running" {
        return Err(AppError::InvalidRequest(
            "agent iteration requires a running turn".into(),
        ));
    }
    let expected = usize::try_from(row.iteration_count).unwrap_or(usize::MAX) + 1;
    if request.iteration != expected {
        return Err(AppError::InvalidRequest(format!(
            "agent iteration must be the next sequence number ({expected})"
        )));
    }
    let max_iterations = usize::try_from(row.max_iterations).unwrap_or(0);
    if request.iteration > max_iterations {
        return Err(AppError::InvalidRequest(
            "agent iteration exceeds max_iterations".into(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE harness_agent_turns SET iteration_count=?1, updated_at=unixepoch() \
         WHERE id=?2 AND status='running' AND iteration_count=?3",
    )
    .bind(i64::try_from(request.iteration).unwrap_or(i64::MAX))
    .bind(&request.turn_id)
    .bind(row.iteration_count)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::InvalidRequest(
            "agent turn changed concurrently; reload before recording iteration".into(),
        ));
    }
    super::append_event_tx(
        &mut tx,
        &row.run_id,
        "agent/iteration",
        &serde_json::json!({
            "turn_id": request.turn_id,
            "iteration": request.iteration,
        }),
    )
    .await?;
    super::append_event_tx(
        &mut tx,
        &row.run_id,
        "agent/decision",
        &serde_json::json!({
            "turn_id": request.turn_id,
            "iteration": request.iteration,
            "decision": request.decision,
            "tool": request.tool_name,
        }),
    )
    .await?;
    tx.commit().await?;

    let turn = turn_view(load_turn(state, &request.turn_id).await?)?;
    Ok(HarnessAgentTurnIterationResult {
        iteration_limit_reached: turn.iteration_count >= turn.max_iterations,
        turn,
    })
}

pub async fn complete(
    state: &AppState,
    request: HarnessAgentTurnCompleteRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentTurnView> {
    validate_terminal(&request.status, &request.stop_reason)?;
    if request.input_tokens < 0 || request.output_tokens < 0 {
        return Err(AppError::InvalidRequest(
            "agent token counters must be non-negative".into(),
        ));
    }
    let row = load_turn(state, &request.turn_id).await?;
    authorize_turn(state, &row, principal_id, operator).await?;
    if row.status != "running" {
        if row.status == request.status
            && row.stop_reason == request.stop_reason
            && row.input_tokens == request.input_tokens
            && row.output_tokens == request.output_tokens
        {
            return turn_view(row);
        }
        return Err(AppError::InvalidRequest(
            "agent turn is already terminal".into(),
        ));
    }
    if request.status == "iteration-limit" && row.iteration_count < row.max_iterations {
        return Err(AppError::InvalidRequest(
            "agent iteration-limit status requires max_iterations to be reached".into(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE harness_agent_turns \
         SET status=?1, stop_reason=?2, input_tokens=?3, output_tokens=?4, \
             completed_at=unixepoch(), updated_at=unixepoch() \
         WHERE id=?5 AND status='running'",
    )
    .bind(&request.status)
    .bind(&request.stop_reason)
    .bind(request.input_tokens)
    .bind(request.output_tokens)
    .bind(&request.turn_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::InvalidRequest(
            "agent turn changed concurrently; reload before completing".into(),
        ));
    }
    super::append_event_tx(
        &mut tx,
        &row.run_id,
        "agent/turn_completed",
        &serde_json::json!({
            "turn_id": request.turn_id,
            "status": request.status,
            "stop_reason": request.stop_reason,
            "iteration_count": row.iteration_count,
            "input_tokens": request.input_tokens,
            "output_tokens": request.output_tokens,
        }),
    )
    .await?;
    tx.commit().await?;
    turn_view(load_turn(state, &request.turn_id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_are_structural_not_reasoning_text() {
        assert!(validate_decision("reply", &None).is_ok());
        assert!(validate_decision("tool", &Some("plugin_catalog".into())).is_ok());
        assert!(validate_decision("tool", &None).is_err());
        assert!(validate_decision("analysis: secret reasoning", &None).is_err());
    }

    #[test]
    fn stop_reasons_are_bounded_enums() {
        assert!(validate_terminal("completed", &Some("model-reply".into())).is_ok());
        assert!(validate_terminal("failed", &Some("provider leaked details".into())).is_err());
    }
}
