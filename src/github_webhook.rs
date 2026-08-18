use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    github,
    service::AppState,
};

const MAX_DELIVERY_ID_BYTES: usize = 128;
const MAX_EVENT_NAME_BYTES: usize = 64;
const MAX_REPOSITORY_BYTES: usize = 256;
const MAX_ACTION_BYTES: usize = 64;
const MAX_PROVIDER_STATE_BYTES: usize = 64;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GitHubWebhookResult {
    pub provider: &'static str,
    pub accepted: bool,
    pub replayed: bool,
    pub delivery_id: String,
    pub event: String,
    pub action: Option<String>,
    pub workspace: Option<String>,
    pub task_id: Option<String>,
    pub pull_number: Option<u64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GitHubObservationSummary {
    pub provider: &'static str,
    pub repository: String,
    pub pull_number: u64,
    pub pull_head_sha: String,
    pub pull_state: Option<String>,
    pub pull_merged: Option<bool>,
    pub latest_check_status: Option<String>,
    pub latest_check_conclusion: Option<String>,
    pub latest_review_state: Option<String>,
    pub last_event: String,
    pub last_action: Option<String>,
    pub last_delivery_id: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
struct ParsedObservation {
    repository: String,
    pull_number: u64,
    pull_head_sha: String,
    action: Option<String>,
    pull_state: Option<String>,
    pull_merged: Option<bool>,
    check_status: Option<String>,
    check_conclusion: Option<String>,
    review_state: Option<String>,
}

#[derive(Debug, Clone)]
struct LinkedTask {
    workspace: String,
    task_id: String,
}

type DeliveryDbRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

type LifecycleMatchRow = (String, Option<String>, Option<String>);
type SummaryDbRow = (
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i64,
);

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn valid_header(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn bounded_string(value: Option<&str>, max: usize) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && value.len() <= max && value.is_ascii())
        .map(ToOwned::to_owned)
}

fn single_pull_number(value: &serde_json::Value) -> Option<u64> {
    let pulls = value.as_array()?;
    let mut number = None;
    for pull in pulls {
        let current = pull.get("number")?.as_u64()?;
        match number {
            None => number = Some(current),
            Some(existing) if existing == current => {}
            Some(_) => return None,
        }
    }
    number
}

fn parse_observation(event: &str, payload: &serde_json::Value) -> Option<ParsedObservation> {
    let repository = payload.pointer("/repository/full_name")?.as_str()?;
    if repository.is_empty() || repository.len() > MAX_REPOSITORY_BYTES || !repository.is_ascii() {
        return None;
    }
    let action = bounded_string(
        payload.get("action").and_then(serde_json::Value::as_str),
        MAX_ACTION_BYTES,
    );

    let mut observation = ParsedObservation {
        repository: repository.to_string(),
        pull_number: 0,
        pull_head_sha: String::new(),
        action,
        pull_state: None,
        pull_merged: None,
        check_status: None,
        check_conclusion: None,
        review_state: None,
    };

    match event {
        "pull_request" => {
            let pull = payload.get("pull_request")?;
            observation.pull_number = pull
                .get("number")
                .and_then(serde_json::Value::as_u64)
                .or_else(|| payload.get("number").and_then(serde_json::Value::as_u64))?;
            observation.pull_head_sha = pull.pointer("/head/sha")?.as_str()?.to_string();
            observation.pull_state = bounded_string(
                pull.get("state").and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
            observation.pull_merged = pull.get("merged").and_then(serde_json::Value::as_bool);
        }
        "pull_request_review" => {
            let pull = payload.get("pull_request")?;
            observation.pull_number = pull
                .get("number")
                .and_then(serde_json::Value::as_u64)
                .or_else(|| payload.get("number").and_then(serde_json::Value::as_u64))?;
            observation.pull_head_sha = pull.pointer("/head/sha")?.as_str()?.to_string();
            observation.review_state = bounded_string(
                payload
                    .pointer("/review/state")
                    .and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
        }
        "check_run" => {
            let check = payload.get("check_run")?;
            observation.pull_number = single_pull_number(check.get("pull_requests")?)?;
            observation.pull_head_sha = check.get("head_sha")?.as_str()?.to_string();
            observation.check_status = bounded_string(
                check.get("status").and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
            observation.check_conclusion = bounded_string(
                check.get("conclusion").and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
        }
        "check_suite" => {
            let suite = payload.get("check_suite")?;
            observation.pull_number = single_pull_number(suite.get("pull_requests")?)?;
            observation.pull_head_sha = suite.get("head_sha")?.as_str()?.to_string();
            observation.check_status = bounded_string(
                suite.get("status").and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
            observation.check_conclusion = bounded_string(
                suite.get("conclusion").and_then(serde_json::Value::as_str),
                MAX_PROVIDER_STATE_BYTES,
            );
        }
        _ => return None,
    }

    if observation.pull_number == 0
        || observation.pull_head_sha.len() != 40
        || !observation
            .pull_head_sha
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(observation)
}

async fn find_workspace(state: &AppState, repository: &str) -> AppResult<Option<String>> {
    let mut matched = None;
    for view in state.workspaces.list() {
        let workspace = state.workspaces.get(&view.id)?;
        if workspace.provider.as_deref() != Some("github") {
            continue;
        }
        let configured_repository = workspace
            .repository
            .as_deref()
            .or(workspace.github_repository.as_deref());
        let candidate = github::repository_for_workspace(
            &workspace.root,
            &workspace.remote,
            configured_repository,
        )
        .await;
        let Ok(candidate) = candidate else {
            continue;
        };
        if candidate.eq_ignore_ascii_case(repository) {
            if matched.is_some() {
                return Ok(None);
            }
            matched = Some(workspace.id);
        }
    }
    Ok(matched)
}

async fn find_task(
    state: &AppState,
    workspace: &str,
    observation: &ParsedObservation,
) -> AppResult<Option<LinkedTask>> {
    let pull_number = i64::try_from(observation.pull_number)
        .map_err(|_| AppError::InvalidRequest("GitHub pull number is out of range".into()))?;
    let rows: Vec<LifecycleMatchRow> = sqlx::query_as(
        "SELECT tl.task_id, tl.push_sha, tl.pull_head_sha \
         FROM task_lifecycle tl \
         JOIN tasks t ON t.id=tl.task_id \
         WHERE t.workspace_id=?1 AND tl.pull_number=?2",
    )
    .bind(workspace)
    .bind(pull_number)
    .fetch_all(&state.db)
    .await?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let row = &rows[0];
    let expected_head = row.1.as_deref().or(row.2.as_deref());
    if expected_head != Some(observation.pull_head_sha.as_str()) {
        return Ok(None);
    }
    Ok(Some(LinkedTask {
        workspace: workspace.to_string(),
        task_id: row.0.clone(),
    }))
}

fn result_from_row(row: &DeliveryDbRow, replayed: bool) -> GitHubWebhookResult {
    GitHubWebhookResult {
        provider: "github",
        accepted: true,
        replayed,
        delivery_id: row.0.clone(),
        event: row.1.clone(),
        action: row.8.clone(),
        workspace: Some(row.3.clone()),
        task_id: Some(row.4.clone()),
        pull_number: u64::try_from(row.6).ok(),
    }
}

async fn load_delivery(state: &AppState, delivery_id: &str) -> AppResult<Option<DeliveryDbRow>> {
    Ok(sqlx::query_as(
        "SELECT delivery_id, event_name, payload_fingerprint, workspace_id, task_id, repository, \
                pull_number, pull_head_sha, action, pull_state, pull_merged, check_status, \
                check_conclusion, review_state, created_at \
         FROM github_webhook_deliveries WHERE delivery_id=?1",
    )
    .bind(delivery_id)
    .fetch_optional(&state.db)
    .await?)
}

pub async fn ingest(
    state: &AppState,
    delivery_id: &str,
    event: &str,
    raw_body: &[u8],
    payload: &serde_json::Value,
) -> AppResult<GitHubWebhookResult> {
    if !valid_header(delivery_id, MAX_DELIVERY_ID_BYTES) {
        return Err(AppError::InvalidRequest(
            "invalid X-GitHub-Delivery header".into(),
        ));
    }
    if !valid_header(event, MAX_EVENT_NAME_BYTES) {
        return Err(AppError::InvalidRequest(
            "invalid X-GitHub-Event header".into(),
        ));
    }
    let fingerprint = sha256(raw_body);
    if let Some(existing) = load_delivery(state, delivery_id).await? {
        if existing.2 != fingerprint {
            return Err(AppError::InvalidRequest(
                "GitHub delivery ID already exists with a different payload".into(),
            ));
        }
        return Ok(result_from_row(&existing, true));
    }

    let Some(observation) = parse_observation(event, payload) else {
        return Ok(GitHubWebhookResult {
            provider: "github",
            accepted: false,
            replayed: false,
            delivery_id: delivery_id.to_string(),
            event: event.to_string(),
            action: bounded_string(
                payload.get("action").and_then(serde_json::Value::as_str),
                MAX_ACTION_BYTES,
            ),
            workspace: None,
            task_id: None,
            pull_number: None,
        });
    };
    let Some(workspace) = find_workspace(state, &observation.repository).await? else {
        return Ok(GitHubWebhookResult {
            provider: "github",
            accepted: false,
            replayed: false,
            delivery_id: delivery_id.to_string(),
            event: event.to_string(),
            action: observation.action,
            workspace: None,
            task_id: None,
            pull_number: Some(observation.pull_number),
        });
    };
    let Some(linked) = find_task(state, &workspace, &observation).await? else {
        return Ok(GitHubWebhookResult {
            provider: "github",
            accepted: false,
            replayed: false,
            delivery_id: delivery_id.to_string(),
            event: event.to_string(),
            action: observation.action,
            workspace: Some(workspace),
            task_id: None,
            pull_number: Some(observation.pull_number),
        });
    };

    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO github_webhook_deliveries(\
            delivery_id, event_name, payload_fingerprint, workspace_id, task_id, repository, \
            pull_number, pull_head_sha, action, pull_state, pull_merged, check_status, \
            check_conclusion, review_state, created_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, unixepoch()) \
         ON CONFLICT(delivery_id) DO NOTHING",
    )
    .bind(delivery_id)
    .bind(event)
    .bind(&fingerprint)
    .bind(&linked.workspace)
    .bind(&linked.task_id)
    .bind(&observation.repository)
    .bind(
        i64::try_from(observation.pull_number)
            .map_err(|_| AppError::InvalidRequest("GitHub pull number is out of range".into()))?,
    )
    .bind(&observation.pull_head_sha)
    .bind(&observation.action)
    .bind(&observation.pull_state)
    .bind(observation.pull_merged.map(i64::from))
    .bind(&observation.check_status)
    .bind(&observation.check_conclusion)
    .bind(&observation.review_state)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;

    if inserted {
        let metadata = serde_json::json!({
            "provider": "github",
            "delivery_id": delivery_id,
            "event": event,
            "action": observation.action,
            "pull_number": observation.pull_number,
            "pull_head_sha": observation.pull_head_sha,
        });
        sqlx::query(
            "INSERT INTO task_events(task_id, event_type, metadata_json, created_at) \
             VALUES(?1, 'github_webhook_observed', ?2, unixepoch())",
        )
        .bind(&linked.task_id)
        .bind(serde_json::to_string(&metadata).map_err(anyhow::Error::from)?)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let stored = load_delivery(state, delivery_id).await?.ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("GitHub webhook delivery disappeared"))
    })?;
    if stored.2 != fingerprint {
        return Err(AppError::InvalidRequest(
            "GitHub delivery ID already exists with a different payload".into(),
        ));
    }
    Ok(result_from_row(&stored, !inserted))
}

pub async fn summary_for_task(
    state: &AppState,
    task_id: &str,
) -> AppResult<Option<GitHubObservationSummary>> {
    let rows: Vec<SummaryDbRow> = sqlx::query_as(
        "SELECT repository, pull_number, pull_head_sha, event_name, action, pull_state, pull_merged, \
                check_status, check_conclusion, review_state, delivery_id, created_at \
         FROM github_webhook_deliveries \
         WHERE task_id=?1 ORDER BY id DESC LIMIT 100",
    )
    .bind(task_id)
    .fetch_all(&state.db)
    .await?;
    let Some(first) = rows.first() else {
        return Ok(None);
    };

    let mut pull_state = None;
    let mut pull_merged = None;
    let mut check_status = None;
    let mut check_conclusion = None;
    let mut review_state = None;
    for row in &rows {
        if pull_state.is_none() {
            pull_state = row.5.clone();
        }
        if pull_merged.is_none() {
            pull_merged = row.6.map(|value| value != 0);
        }
        if check_status.is_none() {
            check_status = row.7.clone();
        }
        if check_conclusion.is_none() {
            check_conclusion = row.8.clone();
        }
        if review_state.is_none() {
            review_state = row.9.clone();
        }
    }

    Ok(Some(GitHubObservationSummary {
        provider: "github",
        repository: first.0.clone(),
        pull_number: u64::try_from(first.1)
            .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid stored pull number")))?,
        pull_head_sha: first.2.clone(),
        pull_state,
        pull_merged,
        latest_check_status: check_status,
        latest_check_conclusion: check_conclusion,
        latest_review_state: review_state,
        last_event: first.3.clone(),
        last_action: first.4.clone(),
        last_delivery_id: first.10.clone(),
        updated_at: first.11,
    }))
}

#[cfg(test)]
mod tests {
    use super::parse_observation;

    #[test]
    fn parses_pull_request_without_review_or_body_content() {
        let payload = serde_json::json!({
            "action": "closed",
            "repository": { "full_name": "owner/repo" },
            "pull_request": {
                "number": 42,
                "state": "closed",
                "merged": true,
                "head": { "sha": "0123456789abcdef0123456789abcdef01234567" },
                "body": "must never be persisted"
            }
        });
        let parsed = parse_observation("pull_request", &payload).expect("parse pull request");
        assert_eq!(parsed.pull_number, 42);
        assert_eq!(parsed.pull_state.as_deref(), Some("closed"));
        assert_eq!(parsed.pull_merged, Some(true));
        let encoded = format!("{parsed:?}");
        assert!(!encoded.contains("must never be persisted"));
    }

    #[test]
    fn ambiguous_check_pull_link_is_rejected() {
        let payload = serde_json::json!({
            "action": "completed",
            "repository": { "full_name": "owner/repo" },
            "check_run": {
                "head_sha": "0123456789abcdef0123456789abcdef01234567",
                "status": "completed",
                "conclusion": "success",
                "pull_requests": [{"number": 1}, {"number": 2}]
            }
        });
        assert!(parse_observation("check_run", &payload).is_none());
    }
}
