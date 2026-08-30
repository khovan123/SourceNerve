use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

use super::{HarnessRunIdRequest, agent::HarnessAgentTurnIdRequest};

const EVALUATOR_VERSION: i64 = 1;
const DEFAULT_LIST_LIMIT: usize = 20;
const MAX_LIST_LIMIT: usize = 100;
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_MODEL_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentEvaluateRequest {
    pub turn_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentEvaluationListRequest {
    pub turn_id: String,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessAgentJudgeRecordRequest {
    pub evaluation_id: String,
    pub verdict: String,
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessAgentEvalCheck {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessAgentEvalMetrics {
    pub iterations: i64,
    pub max_iterations: i64,
    pub context_reads: i64,
    pub executions: i64,
    pub failure_count: i64,
    pub learning_count: i64,
    pub satisfied_proofs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessAgentEvaluationView {
    pub id: String,
    pub turn_id: String,
    pub evaluator_version: i64,
    pub deterministic_verdict: String,
    pub checks: Vec<HarnessAgentEvalCheck>,
    pub metrics: HarnessAgentEvalMetrics,
    pub judge_verdict: Option<String>,
    pub judge_provider_id: Option<String>,
    pub judge_model_id: Option<String>,
    pub final_verdict: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessAgentEvaluationListResult {
    pub evaluations: Vec<HarnessAgentEvaluationView>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct EvaluationRow {
    id: String,
    turn_id: String,
    evaluator_version: i64,
    deterministic_verdict: String,
    checks_json: String,
    metrics_json: String,
    judge_verdict: Option<String>,
    judge_provider_id: Option<String>,
    judge_model_id: Option<String>,
    created_at: i64,
}

fn default_list_limit() -> usize {
    DEFAULT_LIST_LIMIT
}

fn bounded_id(value: &str, max: usize, label: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest(format!(
            "{label} must be 1-{max} non-control UTF-8 bytes"
        )));
    }
    Ok(())
}

fn evaluation_view(row: EvaluationRow) -> AppResult<HarnessAgentEvaluationView> {
    let checks = serde_json::from_str::<Vec<HarnessAgentEvalCheck>>(&row.checks_json)
        .map_err(anyhow::Error::from)?;
    let metrics = serde_json::from_str::<HarnessAgentEvalMetrics>(&row.metrics_json)
        .map_err(anyhow::Error::from)?;
    let final_verdict =
        if row.deterministic_verdict == "fail" || row.judge_verdict.as_deref() == Some("fail") {
            "fail"
        } else {
            "pass"
        };
    Ok(HarnessAgentEvaluationView {
        id: row.id,
        turn_id: row.turn_id,
        evaluator_version: row.evaluator_version,
        deterministic_verdict: row.deterministic_verdict,
        checks,
        metrics,
        judge_verdict: row.judge_verdict,
        judge_provider_id: row.judge_provider_id,
        judge_model_id: row.judge_model_id,
        final_verdict: final_verdict.to_string(),
        created_at: row.created_at,
    })
}

async fn load_evaluation(state: &AppState, evaluation_id: &str) -> AppResult<EvaluationRow> {
    bounded_id(evaluation_id, 128, "agent evaluation_id")?;
    sqlx::query_as::<_, EvaluationRow>(
        "SELECT id, turn_id, evaluator_version, deterministic_verdict, checks_json, metrics_json, \
                judge_verdict, judge_provider_id, judge_model_id, created_at \
         FROM harness_agent_evaluations WHERE id=?1",
    )
    .bind(evaluation_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::InvalidRequest(format!("agent evaluation not found: {evaluation_id}")))
}

pub async fn evaluate(
    state: &AppState,
    request: HarnessAgentEvaluateRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentEvaluationView> {
    let turn = super::agent::get(
        state,
        HarnessAgentTurnIdRequest {
            turn_id: request.turn_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    let run = super::get(
        state,
        HarnessRunIdRequest {
            run_id: turn.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;

    let terminal = turn.status != "running";
    let iteration_within_limit = turn.iteration_count <= turn.max_iterations;
    let run_healthy = !matches!(run.run.status.as_str(), "stale" | "cancelled" | "failed");
    let freshness_current = run.freshness.state == "current";
    let recovery_clear = !matches!(
        run.closed_loop.recovery_status.as_str(),
        "needed" | "in-progress"
    );
    let verification_satisfied =
        !run.closed_loop.verification_required || run.closed_loop.verification_status == "passed";
    let selected_proof_satisfied =
        run.closed_loop
            .selected_proof_type
            .as_ref()
            .is_none_or(|proof| {
                run.closed_loop
                    .satisfied_proofs
                    .iter()
                    .any(|value| value == proof)
            });

    let checks = vec![
        HarnessAgentEvalCheck {
            name: "turn-terminal".into(),
            passed: terminal,
            detail: if terminal {
                "agent turn is terminal"
            } else {
                "agent turn is still running"
            }
            .into(),
        },
        HarnessAgentEvalCheck {
            name: "iteration-limit".into(),
            passed: iteration_within_limit,
            detail: "iteration count does not exceed the configured hard limit".into(),
        },
        HarnessAgentEvalCheck {
            name: "run-health".into(),
            passed: run_healthy,
            detail: "Harness run is not stale, cancelled, or failed".into(),
        },
        HarnessAgentEvalCheck {
            name: "freshness".into(),
            passed: freshness_current,
            detail: "Harness snapshot still matches repository authority state".into(),
        },
        HarnessAgentEvalCheck {
            name: "recovery".into(),
            passed: recovery_clear,
            detail: "no unresolved Harness recovery is required".into(),
        },
        HarnessAgentEvalCheck {
            name: "verification".into(),
            passed: verification_satisfied,
            detail: "required deterministic verification is satisfied".into(),
        },
        HarnessAgentEvalCheck {
            name: "selected-proof".into(),
            passed: selected_proof_satisfied,
            detail: "selected repository proof is satisfied when one is required".into(),
        },
    ];
    let deterministic_verdict = if checks.iter().all(|check| check.passed) {
        "pass"
    } else {
        "fail"
    };
    let metrics = HarnessAgentEvalMetrics {
        iterations: i64::try_from(turn.iteration_count).unwrap_or(i64::MAX),
        max_iterations: i64::try_from(turn.max_iterations).unwrap_or(i64::MAX),
        context_reads: run.closed_loop.context_reads,
        executions: run.closed_loop.executions,
        failure_count: run.closed_loop.failure_count,
        learning_count: run.closed_loop.learning_count,
        satisfied_proofs: i64::try_from(run.closed_loop.satisfied_proofs.len()).unwrap_or(i64::MAX),
        input_tokens: turn.input_tokens,
        output_tokens: turn.output_tokens,
    };

    let id = Uuid::new_v4().to_string();
    let checks_json = serde_json::to_string(&checks).map_err(anyhow::Error::from)?;
    let metrics_json = serde_json::to_string(&metrics).map_err(anyhow::Error::from)?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_agent_evaluations( \
             id, turn_id, evaluator_version, deterministic_verdict, checks_json, metrics_json, created_at \
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, unixepoch())",
    )
    .bind(&id)
    .bind(&turn.id)
    .bind(EVALUATOR_VERSION)
    .bind(deterministic_verdict)
    .bind(checks_json)
    .bind(metrics_json)
    .execute(&mut *tx)
    .await?;
    super::append_event_tx(
        &mut tx,
        &turn.run_id,
        "agent/evaluated",
        &serde_json::json!({
            "turn_id": turn.id,
            "evaluation_id": id,
            "evaluator_version": EVALUATOR_VERSION,
            "verdict": deterministic_verdict,
        }),
    )
    .await?;
    tx.commit().await?;
    evaluation_view(load_evaluation(state, &id).await?)
}

pub async fn list(
    state: &AppState,
    request: HarnessAgentEvaluationListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentEvaluationListResult> {
    super::agent::get(
        state,
        HarnessAgentTurnIdRequest {
            turn_id: request.turn_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    let limit = request.limit.clamp(1, MAX_LIST_LIMIT) as i64;
    let rows = sqlx::query_as::<_, EvaluationRow>(
        "SELECT id, turn_id, evaluator_version, deterministic_verdict, checks_json, metrics_json, \
                judge_verdict, judge_provider_id, judge_model_id, created_at \
         FROM harness_agent_evaluations WHERE turn_id=?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(&request.turn_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(HarnessAgentEvaluationListResult {
        evaluations: rows
            .into_iter()
            .map(evaluation_view)
            .collect::<AppResult<Vec<_>>>()?,
    })
}

pub async fn record_judge(
    state: &AppState,
    request: HarnessAgentJudgeRecordRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessAgentEvaluationView> {
    if !matches!(request.verdict.as_str(), "pass" | "fail") {
        return Err(AppError::InvalidRequest(
            "agent judge verdict must be pass or fail".into(),
        ));
    }
    bounded_id(
        &request.provider_id,
        MAX_PROVIDER_ID_BYTES,
        "agent judge provider_id",
    )?;
    bounded_id(
        &request.model_id,
        MAX_MODEL_ID_BYTES,
        "agent judge model_id",
    )?;
    let row = load_evaluation(state, &request.evaluation_id).await?;
    let turn = super::agent::get(
        state,
        HarnessAgentTurnIdRequest {
            turn_id: row.turn_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE harness_agent_evaluations \
         SET judge_verdict=?1, judge_provider_id=?2, judge_model_id=?3 \
         WHERE id=?4 AND judge_verdict IS NULL",
    )
    .bind(&request.verdict)
    .bind(&request.provider_id)
    .bind(&request.model_id)
    .bind(&request.evaluation_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        let existing = load_evaluation(state, &request.evaluation_id).await?;
        if existing.judge_verdict.as_deref() != Some(request.verdict.as_str())
            || existing.judge_provider_id.as_deref() != Some(request.provider_id.as_str())
            || existing.judge_model_id.as_deref() != Some(request.model_id.as_str())
        {
            return Err(AppError::InvalidRequest(
                "agent evaluation already has a different judge result".into(),
            ));
        }
        return evaluation_view(existing);
    }

    super::append_event_tx(
        &mut tx,
        &turn.run_id,
        "agent/judge_recorded",
        &serde_json::json!({
            "turn_id": turn.id,
            "evaluation_id": request.evaluation_id,
            "judge_verdict": request.verdict,
            "provider_id": request.provider_id,
            "model_id": request.model_id,
        }),
    )
    .await?;
    tx.commit().await?;
    evaluation_view(load_evaluation(state, &request.evaluation_id).await?)
}

#[cfg(test)]
mod tests {
    use super::{EvaluationRow, HarnessAgentEvalCheck, HarnessAgentEvalMetrics, evaluation_view};

    #[test]
    fn judge_can_downgrade_but_never_upgrade_deterministic_failure() {
        let metrics = HarnessAgentEvalMetrics {
            iterations: 1,
            max_iterations: 4,
            context_reads: 1,
            executions: 0,
            failure_count: 0,
            learning_count: 0,
            satisfied_proofs: 0,
            input_tokens: 1,
            output_tokens: 1,
        };
        let row = EvaluationRow {
            id: "eval".into(),
            turn_id: "turn".into(),
            evaluator_version: 1,
            deterministic_verdict: "fail".into(),
            checks_json: serde_json::to_string(&vec![HarnessAgentEvalCheck {
                name: "x".into(),
                passed: false,
                detail: "failed".into(),
            }])
            .unwrap(),
            metrics_json: serde_json::to_string(&metrics).unwrap(),
            judge_verdict: Some("pass".into()),
            judge_provider_id: Some("judge".into()),
            judge_model_id: Some("model".into()),
            created_at: 1,
        };
        assert_eq!(evaluation_view(row).unwrap().final_verdict, "fail");
    }
}
