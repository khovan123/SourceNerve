use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    process::Stdio,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    net::lookup_host,
    process::Command,
    time::{Duration, sleep},
};

use crate::{
    config::Config,
    error::{AppError, AppResult},
    service::AppState,
};

const MAX_CALLBACK_URL_BYTES: usize = 2048;
const MAX_ATTEMPTS: i64 = 5;
const BASE_DELAY_SECONDS: i64 = 2;
const MAX_DELAY_SECONDS: i64 = 300;
const WORKER_IDLE_MILLIS: u64 = 500;

type GitHubCallbackSourceRow = (
    String,
    Option<String>,
    String,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    target: CallbackTarget,
    secret: String,
}

#[derive(Debug, Clone)]
struct CallbackTarget {
    raw: String,
    scheme: &'static str,
    host: String,
    port: u16,
    literal_ip: Option<IpAddr>,
    allow_insecure_loopback: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct OutboxRow {
    id: i64,
    delivery_id: String,
    event_key: String,
    source_kind: String,
    source_id: i64,
    workspace_id: String,
    task_id: Option<String>,
    job_id: Option<String>,
    status: String,
    attempts: i64,
    next_attempt_at: i64,
    last_http_status: Option<i64>,
    last_error_code: Option<String>,
    delivered_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CallbackDeliveryRequest {
    pub delivery_id: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CallbackDeliveryView {
    pub delivery_id: String,
    pub event_key: String,
    pub source_kind: String,
    pub workspace: String,
    pub task_id: Option<String>,
    pub job_id: Option<String>,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub last_http_status: Option<i64>,
    pub last_error_code: Option<String>,
    pub delivered_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug)]
enum AttemptOutcome {
    Delivered(u16),
    Retryable {
        http_status: Option<u16>,
        error_code: String,
    },
}

impl RuntimeConfig {
    pub fn from_config(config: &Config) -> AppResult<Option<Self>> {
        let Some(raw) = config.callback_url.as_deref() else {
            return Ok(None);
        };
        let secret = config.callback_secret.clone().ok_or_else(|| {
            AppError::InvalidRequest(
                "callback secret is missing while callback URL is configured".into(),
            )
        })?;
        let target = CallbackTarget::parse(raw, config.callback_allow_insecure_loopback)?;
        Ok(Some(Self { target, secret }))
    }
}

impl CallbackTarget {
    fn parse(raw: &str, allow_insecure_loopback: bool) -> AppResult<Self> {
        if raw.is_empty()
            || raw.len() > MAX_CALLBACK_URL_BYTES
            || !raw.is_ascii()
            || raw.bytes().any(|byte| byte.is_ascii_control())
            || raw.chars().any(char::is_whitespace)
            || raw.contains('#')
        {
            return Err(AppError::InvalidRequest(
                "callback URL must be a bounded ASCII URL without whitespace, controls, or fragments"
                    .into(),
            ));
        }

        let (scheme, rest) = if let Some(rest) = raw.strip_prefix("https://") {
            ("https", rest)
        } else if let Some(rest) = raw.strip_prefix("http://") {
            if !allow_insecure_loopback {
                return Err(AppError::InvalidRequest(
                    "callback URL must use HTTPS unless insecure loopback mode is explicitly enabled"
                        .into(),
                ));
            }
            ("http", rest)
        } else {
            return Err(AppError::InvalidRequest(
                "callback URL scheme must be https".into(),
            ));
        };

        let authority_end = rest
            .find(|ch| ['/', '?'].contains(&ch))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.is_empty() || authority.contains('@') {
            return Err(AppError::InvalidRequest(
                "callback URL must not contain credentials and must include a host".into(),
            ));
        }

        let default_port = if scheme == "https" { 443 } else { 80 };
        let (host, port, literal_ip) = parse_authority(authority, default_port)?;
        if scheme == "http" {
            let Some(ip) = literal_ip else {
                return Err(AppError::InvalidRequest(
                    "insecure callback mode accepts only a literal loopback IP".into(),
                ));
            };
            if !ip.is_loopback() {
                return Err(AppError::InvalidRequest(
                    "insecure callback mode accepts only a literal loopback IP".into(),
                ));
            }
        }
        if scheme == "https" {
            if let Some(ip) = literal_ip {
                if !is_public_ip(ip) {
                    return Err(AppError::InvalidRequest(
                        "callback URL literal IP is not globally routable".into(),
                    ));
                }
            }
        }

        Ok(Self {
            raw: raw.to_string(),
            scheme,
            host,
            port,
            literal_ip,
            allow_insecure_loopback,
        })
    }

    async fn resolve_for_attempt(&self) -> Result<Option<String>, String> {
        if let Some(ip) = self.literal_ip {
            if self.scheme == "http" && self.allow_insecure_loopback && ip.is_loopback() {
                return Ok(None);
            }
            if self.scheme == "https" && is_public_ip(ip) {
                return Ok(None);
            }
            return Err("callback_target_not_public".into());
        }

        let addresses = lookup_host((self.host.as_str(), self.port))
            .await
            .map_err(|_| "callback_dns_failed".to_string())?;
        for socket in addresses {
            let ip = socket.ip();
            if is_public_ip(ip) {
                let rendered = match ip {
                    IpAddr::V4(value) => value.to_string(),
                    IpAddr::V6(value) => format!("[{value}]"),
                };
                return Ok(Some(format!("{}:{}:{rendered}", self.host, self.port)));
            }
        }
        Err("callback_dns_no_public_address".into())
    }
}

fn parse_authority(authority: &str, default_port: u16) -> AppResult<(String, u16, Option<IpAddr>)> {
    if authority.starts_with('[') {
        let close = authority.find(']').ok_or_else(|| {
            AppError::InvalidRequest("callback URL has invalid IPv6 authority".into())
        })?;
        let host = &authority[1..close];
        let ip: Ipv6Addr = host
            .parse()
            .map_err(|_| AppError::InvalidRequest("callback URL has invalid IPv6 host".into()))?;
        let suffix = &authority[close + 1..];
        let port = if suffix.is_empty() {
            default_port
        } else {
            let value = suffix.strip_prefix(':').ok_or_else(|| {
                AppError::InvalidRequest("callback URL has invalid IPv6 port".into())
            })?;
            parse_port(value)?
        };
        return Ok((host.to_string(), port, Some(IpAddr::V6(ip))));
    }

    if authority.matches(':').count() > 1 {
        return Err(AppError::InvalidRequest(
            "callback URL IPv6 hosts must use bracket notation".into(),
        ));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, parse_port(port)?),
        None => (authority, default_port),
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(AppError::InvalidRequest(
            "callback URL host contains unsupported characters".into(),
        ));
    }
    let literal_ip = host.parse::<Ipv4Addr>().ok().map(IpAddr::V4);
    Ok((host.to_string(), port, literal_ip))
}

fn parse_port(value: &str) -> AppResult<u16> {
    let port = value
        .parse::<u16>()
        .map_err(|_| AppError::InvalidRequest("callback URL port is invalid".into()))?;
    if port == 0 {
        return Err(AppError::InvalidRequest(
            "callback URL port must be non-zero".into(),
        ));
    }
    Ok(port)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_public_ipv4(value),
        IpAddr::V6(value) => is_public_ipv6(value),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
    {
        return false;
    }
    true
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    let bytes = ip.octets();
    if (bytes[0] & 0xfe) == 0xfc || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) {
        return false;
    }
    if bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8 {
        return false;
    }
    if bytes[..12] == [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] {
        return is_public_ipv4(Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]));
    }
    true
}

fn hmac_sha256(secret: &[u8], body: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key = [0_u8; BLOCK];
    if secret.len() > BLOCK {
        let digest = Sha256::digest(secret);
        key[..digest.len()].copy_from_slice(&digest);
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }

    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for ((inner, outer), key_byte) in inner_pad
        .iter_mut()
        .zip(outer_pad.iter_mut())
        .zip(key.iter())
    {
        *inner ^= *key_byte;
        *outer ^= *key_byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(body);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&digest);
    result
}

pub async fn configure_runtime(state: &AppState, enabled: bool) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE callback_outbox SET status='pending', next_attempt_at=unixepoch(), updated_at=unixepoch() \
         WHERE status='delivering'",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE callback_runtime_state SET enabled=?1, updated_at=unixepoch() WHERE id=1")
        .bind(if enabled { 1_i64 } else { 0_i64 })
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

fn validate_delivery_id(value: &str) -> AppResult<()> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::InvalidRequest(
            "invalid callback delivery_id".into(),
        ));
    }
    Ok(())
}

fn view(row: &OutboxRow) -> CallbackDeliveryView {
    CallbackDeliveryView {
        delivery_id: row.delivery_id.clone(),
        event_key: row.event_key.clone(),
        source_kind: row.source_kind.clone(),
        workspace: row.workspace_id.clone(),
        task_id: row.task_id.clone(),
        job_id: row.job_id.clone(),
        status: row.status.clone(),
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at,
        last_http_status: row.last_http_status,
        last_error_code: row.last_error_code.clone(),
        delivered_at: row.delivered_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

async fn load_by_delivery_id(state: &AppState, delivery_id: &str) -> AppResult<OutboxRow> {
    validate_delivery_id(delivery_id)?;
    sqlx::query_as::<_, OutboxRow>(
        "SELECT id, delivery_id, event_key, source_kind, source_id, workspace_id, task_id, job_id, \
                status, attempts, next_attempt_at, last_http_status, last_error_code, delivered_at, \
                created_at, updated_at \
         FROM callback_outbox WHERE delivery_id=?1",
    )
    .bind(delivery_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::InvalidRequest(format!("callback delivery not found: {delivery_id}")))
}

pub async fn get(
    state: &AppState,
    request: CallbackDeliveryRequest,
) -> AppResult<CallbackDeliveryView> {
    Ok(view(
        &load_by_delivery_id(state, &request.delivery_id).await?,
    ))
}

pub async fn retry_failed(
    state: &AppState,
    request: CallbackDeliveryRequest,
) -> AppResult<CallbackDeliveryView> {
    validate_delivery_id(&request.delivery_id)?;
    let result = sqlx::query(
        "UPDATE callback_outbox \
         SET status='pending', attempts=0, next_attempt_at=unixepoch(), last_http_status=NULL, \
             last_error_code=NULL, delivered_at=NULL, updated_at=unixepoch() \
         WHERE delivery_id=?1 AND status='failed'",
    )
    .bind(&request.delivery_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        let current = load_by_delivery_id(state, &request.delivery_id).await?;
        return Err(AppError::InvalidRequest(format!(
            "callback delivery {} is not failed (status={})",
            request.delivery_id, current.status
        )));
    }
    get(state, request).await
}

async fn claim_due(state: &AppState) -> AppResult<Option<OutboxRow>> {
    let mut tx = state.db.begin().await?;
    let row = sqlx::query_as::<_, OutboxRow>(
        "SELECT id, delivery_id, event_key, source_kind, source_id, workspace_id, task_id, job_id, \
                status, attempts, next_attempt_at, last_http_status, last_error_code, delivered_at, \
                created_at, updated_at \
         FROM callback_outbox \
         WHERE status='pending' AND next_attempt_at <= unixepoch() \
         ORDER BY id LIMIT 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let claimed = sqlx::query(
        "UPDATE callback_outbox \
         SET status='delivering', attempts=attempts+1, updated_at=unixepoch() \
         WHERE id=?1 AND status='pending'",
    )
    .bind(row.id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    tx.commit().await?;
    if !claimed {
        return Ok(None);
    }
    Ok(Some(
        sqlx::query_as::<_, OutboxRow>(
            "SELECT id, delivery_id, event_key, source_kind, source_id, workspace_id, task_id, job_id, \
                    status, attempts, next_attempt_at, last_http_status, last_error_code, delivered_at, \
                    created_at, updated_at FROM callback_outbox WHERE id=?1",
        )
        .bind(row.id)
        .fetch_one(&state.db)
        .await?,
    ))
}

async fn event_envelope(state: &AppState, row: &OutboxRow) -> AppResult<serde_json::Value> {
    let event = match row.source_kind.as_str() {
        "task_event" => {
            let task_id = row.task_id.as_deref().ok_or_else(|| {
                AppError::Internal(anyhow::anyhow!("task callback has no task linkage"))
            })?;
            let value: (String, i64, String, Option<String>) = sqlx::query_as(
                "SELECT e.event_type, e.created_at, t.status, l.phase \
                 FROM task_events e \
                 JOIN tasks t ON t.id=e.task_id \
                 LEFT JOIN task_lifecycle l ON l.task_id=t.id \
                 WHERE e.id=?1 AND e.task_id=?2",
            )
            .bind(row.source_id)
            .bind(task_id)
            .fetch_one(&state.db)
            .await?;
            serde_json::json!({
                "kind": "task",
                "source_event": value.0,
                "workspace": &row.workspace_id,
                "task_id": task_id,
                "job_id": &row.job_id,
                "task_status": value.2,
                "lifecycle_phase": value.3,
                "occurred_at": value.1,
            })
        }
        "job_event" => {
            let job_id = row.job_id.as_deref().ok_or_else(|| {
                AppError::Internal(anyhow::anyhow!("job callback has no job linkage"))
            })?;
            let value: (String, i64, Option<String>, Option<String>, Option<String>) =
                sqlx::query_as(
                    "SELECT e.event_type, e.created_at, j.task_id, t.status, l.phase \
                     FROM job_events e \
                     JOIN jobs j ON j.id=e.job_id \
                     LEFT JOIN tasks t ON t.id=j.task_id \
                     LEFT JOIN task_lifecycle l ON l.task_id=j.task_id \
                     WHERE e.id=?1 AND e.job_id=?2",
                )
                .bind(row.source_id)
                .bind(job_id)
                .fetch_one(&state.db)
                .await?;
            let job_status = derived_job_status(value.3.as_deref(), value.4.as_deref());
            serde_json::json!({
                "kind": "job",
                "source_event": value.0,
                "workspace": &row.workspace_id,
                "task_id": value.2,
                "job_id": job_id,
                "job_status": job_status,
                "task_status": value.3,
                "lifecycle_phase": value.4,
                "occurred_at": value.1,
            })
        }
        "github_observation" => {
            let value: GitHubCallbackSourceRow = sqlx::query_as(
                "SELECT event_name, action, repository, pull_number, pull_head_sha, pull_state, \
                        pull_merged, check_status, check_conclusion, review_state, created_at \
                 FROM github_webhook_deliveries WHERE id=?1",
            )
            .bind(row.source_id)
            .fetch_one(&state.db)
            .await?;
            serde_json::json!({
                "kind": "github",
                "source_event": value.0,
                "action": value.1,
                "workspace": &row.workspace_id,
                "task_id": &row.task_id,
                "job_id": &row.job_id,
                "github_observation": {
                    "repository": value.2,
                    "pull_number": value.3,
                    "pull_head_sha": value.4,
                    "pull_state": value.5,
                    "pull_merged": value.6.map(|flag| flag != 0),
                    "check_status": value.7,
                    "check_conclusion": value.8,
                    "review_state": value.9,
                },
                "occurred_at": value.10,
            })
        }
        other => {
            return Err(AppError::Internal(anyhow::anyhow!(
                "unsupported callback source kind: {other}"
            )));
        }
    };
    Ok(serde_json::json!({
        "schema_version": 1,
        "delivery_id": &row.delivery_id,
        "event": event,
    }))
}

fn derived_job_status(task_status: Option<&str>, lifecycle_phase: Option<&str>) -> &'static str {
    match (task_status, lifecycle_phase) {
        (None, _) => "pending",
        (Some("cancelled"), _) => "cancelled",
        (Some("stale"), _) => "stale",
        (_, Some("completed")) => "completed",
        _ => "active",
    }
}

async fn attempt(
    config: &RuntimeConfig,
    row: &OutboxRow,
    envelope: &serde_json::Value,
) -> AppResult<AttemptOutcome> {
    let body = serde_json::to_vec(envelope).map_err(anyhow::Error::from)?;
    let signature = hex::encode(hmac_sha256(config.secret.as_bytes(), &body));
    let resolve = match config.target.resolve_for_attempt().await {
        Ok(value) => value,
        Err(error_code) => {
            return Ok(AttemptOutcome::Retryable {
                http_status: None,
                error_code,
            });
        }
    };

    let mut command = Command::new("curl");
    command
        .arg("--silent")
        .arg("--request")
        .arg("POST")
        .arg("--connect-timeout")
        .arg("5")
        .arg("--max-time")
        .arg("10")
        .arg("--max-redirs")
        .arg("0")
        .arg("--max-filesize")
        .arg("65536")
        .arg("--output")
        .arg("/dev/null")
        .arg("--write-out")
        .arg("%{http_code}")
        .arg("--proto")
        .arg(if config.target.scheme == "https" {
            "=https"
        } else {
            "=http"
        })
        .arg("--header")
        .arg("Content-Type: application/json")
        .arg("--header")
        .arg(format!("X-SourceNerve-Delivery: {}", row.delivery_id))
        .arg("--header")
        .arg(format!("X-SourceNerve-Event: {}", row.source_kind))
        .arg("--header")
        .arg(format!("X-SourceNerve-Signature: sha256={signature}"))
        .arg("--data-binary")
        .arg("@-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(resolve) = resolve {
        command.arg("--resolve").arg(resolve);
    }
    command.arg(&config.target.raw);

    let mut child = command
        .spawn()
        .map_err(|error| AppError::Command(format!("failed to execute curl: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&body).await?;
        stdin.shutdown().await?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| AppError::Command(format!("callback curl failed: {error}")))?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|code| format!("curl_exit_{code}"))
            .unwrap_or_else(|| "curl_terminated".into());
        return Ok(AttemptOutcome::Retryable {
            http_status: None,
            error_code: code,
        });
    }
    let rendered = String::from_utf8_lossy(&output.stdout);
    let status = rendered.trim().parse::<u16>().map_err(|_| {
        AppError::Internal(anyhow::anyhow!(
            "callback transport returned invalid HTTP status"
        ))
    })?;
    if (200..300).contains(&status) {
        Ok(AttemptOutcome::Delivered(status))
    } else {
        Ok(AttemptOutcome::Retryable {
            http_status: Some(status),
            error_code: format!("http_{status}"),
        })
    }
}

fn retry_delay(attempts: i64) -> i64 {
    let exponent = u32::try_from((attempts - 1).clamp(0, 8)).unwrap_or(0);
    (BASE_DELAY_SECONDS * 2_i64.pow(exponent)).min(MAX_DELAY_SECONDS)
}

async fn persist_outcome(
    state: &AppState,
    row: &OutboxRow,
    outcome: AttemptOutcome,
) -> AppResult<()> {
    match outcome {
        AttemptOutcome::Delivered(status) => {
            sqlx::query(
                "UPDATE callback_outbox \
                 SET status='delivered', last_http_status=?1, last_error_code=NULL, \
                     delivered_at=unixepoch(), updated_at=unixepoch() WHERE id=?2",
            )
            .bind(i64::from(status))
            .bind(row.id)
            .execute(&state.db)
            .await?;
        }
        AttemptOutcome::Retryable {
            http_status,
            error_code,
        } => {
            if row.attempts >= MAX_ATTEMPTS {
                sqlx::query(
                    "UPDATE callback_outbox \
                     SET status='failed', last_http_status=?1, last_error_code=?2, updated_at=unixepoch() \
                     WHERE id=?3",
                )
                .bind(http_status.map(i64::from))
                .bind(error_code)
                .bind(row.id)
                .execute(&state.db)
                .await?;
            } else {
                let delay = retry_delay(row.attempts);
                sqlx::query(
                    "UPDATE callback_outbox \
                     SET status='pending', next_attempt_at=unixepoch()+?1, last_http_status=?2, \
                         last_error_code=?3, updated_at=unixepoch() WHERE id=?4",
                )
                .bind(delay)
                .bind(http_status.map(i64::from))
                .bind(error_code)
                .bind(row.id)
                .execute(&state.db)
                .await?;
            }
        }
    }
    Ok(())
}

pub async fn run_worker(state: AppState, config: RuntimeConfig) {
    loop {
        match claim_due(&state).await {
            Ok(Some(row)) => match event_envelope(&state, &row).await {
                Ok(envelope) => match attempt(&config, &row, &envelope).await {
                    Ok(outcome) => {
                        if let Err(error) = persist_outcome(&state, &row, outcome).await {
                            tracing::error!(delivery_id = %row.delivery_id, error = %error, "callback outcome persistence failed");
                        }
                    }
                    Err(error) => {
                        tracing::error!(delivery_id = %row.delivery_id, error = %error, "callback attempt failed internally");
                        let _ = persist_outcome(
                            &state,
                            &row,
                            AttemptOutcome::Retryable {
                                http_status: None,
                                error_code: "callback_internal_error".into(),
                            },
                        )
                        .await;
                    }
                },
                Err(error) => {
                    tracing::error!(delivery_id = %row.delivery_id, error = %error, "callback envelope materialization failed");
                    let _ = persist_outcome(
                        &state,
                        &row,
                        AttemptOutcome::Retryable {
                            http_status: None,
                            error_code: "callback_source_unavailable".into(),
                        },
                    )
                    .await;
                }
            },
            Ok(None) => sleep(Duration::from_millis(WORKER_IDLE_MILLIS)).await,
            Err(error) => {
                tracing::error!(error = %error, "callback worker failed to claim outbox delivery");
                sleep(Duration::from_millis(WORKER_IDLE_MILLIS)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::{CallbackTarget, hmac_sha256, is_public_ip, retry_delay};

    #[test]
    fn callback_hmac_matches_known_vector() {
        assert_eq!(
            hex::encode(hmac_sha256(
                b"key",
                b"The quick brown fox jumps over the lazy dog"
            )),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn callback_url_rejects_credentials_fragments_and_private_ips() {
        assert!(CallbackTarget::parse("https://user@example.com/hook", false).is_err());
        assert!(CallbackTarget::parse("https://example.com/hook#fragment", false).is_err());
        assert!(CallbackTarget::parse("https://127.0.0.1/hook", false).is_err());
        assert!(CallbackTarget::parse("http://example.com/hook", true).is_err());
        assert!(CallbackTarget::parse("http://127.0.0.1:9000/hook", true).is_ok());
    }

    #[test]
    fn callback_ip_policy_rejects_non_public_ranges() {
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn retry_backoff_is_bounded_and_deterministic() {
        assert_eq!(retry_delay(1), 2);
        assert_eq!(retry_delay(2), 4);
        assert_eq!(retry_delay(5), 32);
        assert_eq!(retry_delay(99), 300);
    }
}
