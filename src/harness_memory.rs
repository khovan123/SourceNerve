use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    context::{self, ContextPack, ContextPackRequest},
    error::{AppError, AppResult},
    service::AppState,
};

use super::{
    HarnessLearningHint, HarnessRunIdRequest, repository_context::HarnessRepositoryContext,
};

const DEFAULT_MAX_ITEMS: usize = 12;
const DEFAULT_MAX_BYTES: usize = 48 * 1024;
const DEFAULT_MAX_EPISODES: usize = 20;
const MAX_EPISODES: usize = 100;
const MAX_QUERY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessMemoryRequest {
    pub run_id: String,
    pub query: String,
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
    #[serde(default = "default_max_episodes")]
    pub max_episodes: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessMemoryEpisode {
    pub seq: i64,
    pub event_type: String,
    pub created_at: i64,
    pub tool: Option<String>,
    pub state: Option<String>,
    pub decision: Option<String>,
    pub route: Option<String>,
    pub result_category: Option<String>,
    pub error_category: Option<String>,
    pub proof_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessProceduralMemory {
    pub repository_context: HarnessRepositoryContext,
    pub learning_hints: Vec<HarnessLearningHint>,
    pub closed_loop_phase: String,
    pub verification_status: String,
    pub recovery_status: String,
    pub selected_proof_type: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct HarnessMemoryResult {
    pub run_id: String,
    pub semantic: ContextPack,
    pub episodic: Vec<HarnessMemoryEpisode>,
    pub procedural: HarnessProceduralMemory,
}

fn default_max_items() -> usize {
    DEFAULT_MAX_ITEMS
}

fn default_max_bytes() -> usize {
    DEFAULT_MAX_BYTES
}

fn default_max_episodes() -> usize {
    DEFAULT_MAX_EPISODES
}

fn bounded_string(payload: &serde_json::Value, key: &str, max: usize) -> Option<String> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
}

pub async fn retrieve(
    state: &AppState,
    request: HarnessMemoryRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessMemoryResult> {
    let query = request.query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest(format!(
            "agent memory query must be 1-{MAX_QUERY_BYTES} non-control UTF-8 bytes"
        )));
    }

    let snapshot = super::get(
        state,
        HarnessRunIdRequest {
            run_id: request.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    if snapshot.run.status != "running" || snapshot.freshness.state != "current" {
        return Err(AppError::InvalidRequest(
            "agent memory retrieval requires a current running Harness run".into(),
        ));
    }

    let semantic = context::pack(
        state,
        ContextPackRequest {
            workspace: snapshot.run.workspace.clone(),
            query: query.to_string(),
            seed_symbol_keys: Vec::new(),
            max_bytes: request.max_bytes,
            max_items: request.max_items,
            require_clean: false,
        },
    )
    .await?;

    let episode_limit = request.max_episodes.clamp(1, MAX_EPISODES) as i64;
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT seq, event_type, payload_json, created_at \
         FROM harness_events WHERE run_id=?1 \
         ORDER BY seq DESC LIMIT ?2",
    )
    .bind(&request.run_id)
    .bind(episode_limit)
    .fetch_all(&state.db)
    .await?;

    let mut episodic = rows
        .into_iter()
        .map(|(seq, event_type, payload_json, created_at)| {
            let payload = serde_json::from_str::<serde_json::Value>(&payload_json)
                .unwrap_or(serde_json::Value::Null);
            HarnessMemoryEpisode {
                seq,
                event_type,
                created_at,
                tool: bounded_string(&payload, "tool", 128),
                state: bounded_string(&payload, "state", 64),
                decision: bounded_string(&payload, "decision", 32),
                route: bounded_string(&payload, "route", 64),
                result_category: bounded_string(&payload, "result_category", 64),
                error_category: bounded_string(&payload, "error_category", 64),
                proof_type: bounded_string(&payload, "proof_type", 64),
            }
        })
        .collect::<Vec<_>>();
    episodic.reverse();

    let procedural = HarnessProceduralMemory {
        repository_context: snapshot.repository_context,
        learning_hints: snapshot.closed_loop.learning_hints,
        closed_loop_phase: snapshot.closed_loop.phase,
        verification_status: snapshot.closed_loop.verification_status,
        recovery_status: snapshot.closed_loop.recovery_status,
        selected_proof_type: snapshot.closed_loop.selected_proof_type,
    };

    Ok(HarnessMemoryResult {
        run_id: request.run_id,
        semantic,
        episodic,
        procedural,
    })
}

#[cfg(test)]
mod tests {
    use super::bounded_string;

    #[test]
    fn episodic_projection_ignores_unallowlisted_payload_content() {
        let payload = serde_json::json!({
            "tool": "context_pack",
            "raw_arguments": "SECRET",
            "output": "SECRET",
        });
        assert_eq!(
            bounded_string(&payload, "tool", 128).as_deref(),
            Some("context_pack")
        );
        assert!(bounded_string(&payload, "raw_arguments", 0).is_none());
    }
}
