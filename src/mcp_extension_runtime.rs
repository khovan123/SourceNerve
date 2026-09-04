use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, watch},
    time::{sleep, timeout},
};

use crate::error::{AppError, AppResult};

pub const MAX_CONNECT_ATTEMPTS: usize = 3;
pub const MAX_IN_FLIGHT_PER_EXTENSION: usize = 4;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const BASE_BACKOFF_MS: u64 = 200;
const MAX_BACKOFF_MS: u64 = 2_000;
const MAX_JITTER_MS: u64 = 100;
const CIRCUIT_OPEN_COOLDOWN: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeState {
    Starting,
    Ready,
    Degraded,
    Retrying,
    Error,
    Stopped,
}

impl RuntimeState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Retrying => "retrying",
            Self::Error => "error",
            Self::Stopped => "stopped",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "starting" => Ok(Self::Starting),
            "ready" => Ok(Self::Ready),
            "degraded" => Ok(Self::Degraded),
            "retrying" => Ok(Self::Retrying),
            "error" => Ok(Self::Error),
            "stopped" => Ok(Self::Stopped),
            other => Err(AppError::Command(format!(
                "invalid persisted MCP runtime state `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeErrorCategory {
    Timeout,
    Connection,
    Protocol,
    Overloaded,
    Cancelled,
    Interrupted,
    Downstream,
    Configuration,
    Unknown,
}

impl RuntimeErrorCategory {
    fn counts_toward_circuit_breaker(self) -> bool {
        matches!(
            self,
            Self::Timeout | Self::Connection | Self::Protocol | Self::Interrupted
        )
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connection => "connection",
            Self::Protocol => "protocol",
            Self::Overloaded => "overloaded",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Downstream => "downstream",
            Self::Configuration => "configuration",
            Self::Unknown => "unknown",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "timeout" => Ok(Self::Timeout),
            "connection" => Ok(Self::Connection),
            "protocol" => Ok(Self::Protocol),
            "overloaded" => Ok(Self::Overloaded),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            "downstream" => Ok(Self::Downstream),
            "configuration" => Ok(Self::Configuration),
            "unknown" => Ok(Self::Unknown),
            other => Err(AppError::Command(format!(
                "invalid persisted MCP runtime error category `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeHealthSnapshot {
    pub extension_id: String,
    pub state: RuntimeState,
    pub consecutive_failures: u32,
    pub in_flight: usize,
    pub generation: u64,
    pub last_error_category: Option<RuntimeErrorCategory>,
    pub last_transition_at: i64,
    pub last_healthy_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct RuntimeStatus {
    state: RuntimeState,
    consecutive_failures: u32,
    last_error_category: Option<RuntimeErrorCategory>,
    last_transition_at: i64,
    last_healthy_at: Option<i64>,
}

#[derive(Clone)]
struct RuntimeControl {
    generation: Arc<AtomicU64>,
    cancel_tx: watch::Sender<u64>,
    semaphore: Arc<Semaphore>,
    half_open_probe: Arc<AtomicBool>,
    status: Arc<Mutex<RuntimeStatus>>,
}

pub struct RuntimeLease {
    extension_id: String,
    generation: u64,
    generation_ref: Arc<AtomicU64>,
    cancel_rx: watch::Receiver<u64>,
    half_open_probe: bool,
    probe_in_flight: Arc<AtomicBool>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for RuntimeLease {
    fn drop(&mut self) {
        if self.half_open_probe {
            self.probe_in_flight.store(false, Ordering::Release);
        }
    }
}

#[derive(Debug, FromRow)]
struct PersistedRuntimeHealthRow {
    extension_id: String,
    state: String,
    consecutive_failures: i64,
    last_error_category: Option<String>,
    last_transition_at: i64,
    last_healthy_at: Option<i64>,
}

static RUNTIME_CONTROLS: OnceLock<Mutex<HashMap<String, RuntimeControl>>> = OnceLock::new();
static RUNTIME_DB: OnceLock<SqlitePool> = OnceLock::new();

fn controls() -> &'static Mutex<HashMap<String, RuntimeControl>> {
    RUNTIME_CONTROLS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn install_persistence(pool: SqlitePool) -> AppResult<()> {
    if RUNTIME_DB.set(pool.clone()).is_err() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE mcp_extension_runtime_health \
         SET state = 'degraded', \
             consecutive_failures = consecutive_failures + 1, \
             last_error_category = 'interrupted', \
             last_transition_at = unixepoch() \
         WHERE state IN ('starting', 'retrying')",
    )
    .execute(&pool)
    .await?;
    Ok(())
}

fn new_control(status: RuntimeStatus) -> RuntimeControl {
    let (cancel_tx, _cancel_rx) = watch::channel(0_u64);
    RuntimeControl {
        generation: Arc::new(AtomicU64::new(0)),
        cancel_tx,
        semaphore: Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_EXTENSION)),
        half_open_probe: Arc::new(AtomicBool::new(false)),
        status: Arc::new(Mutex::new(status)),
    }
}

fn default_status() -> RuntimeStatus {
    RuntimeStatus {
        state: RuntimeState::Starting,
        consecutive_failures: 0,
        last_error_category: None,
        last_transition_at: now_unix(),
        last_healthy_at: None,
    }
}

async fn control(extension_id: &str) -> AppResult<RuntimeControl> {
    if let Some(control) = controls().lock().await.get(extension_id).cloned() {
        return Ok(control);
    }

    let status = match RUNTIME_DB.get() {
        Some(pool) => load_persisted_status(pool, extension_id)
            .await?
            .unwrap_or_else(default_status),
        None => default_status(),
    };
    let candidate = new_control(status);
    let mut values = controls().lock().await;
    Ok(values
        .entry(extension_id.to_owned())
        .or_insert(candidate)
        .clone())
}

pub async fn acquire(extension_id: &str) -> AppResult<RuntimeLease> {
    let control = control(extension_id).await?;
    let mut half_open_probe = false;
    {
        let mut status = control.status.lock().await;
        match status.state {
            RuntimeState::Error => {
                let now = now_unix();
                let retry_at = status
                    .last_transition_at
                    .saturating_add(CIRCUIT_OPEN_COOLDOWN.as_secs() as i64);
                if now < retry_at {
                    return Err(AppError::Command(format!(
                        "MCP extension `{extension_id}` runtime circuit is open after repeated transport failures; automatic recovery probe available in {}s",
                        retry_at.saturating_sub(now)
                    )));
                }
                if control
                    .half_open_probe
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err(AppError::Command(format!(
                        "MCP extension `{extension_id}` automatic recovery probe is already in progress"
                    )));
                }
                half_open_probe = true;
                status.state = RuntimeState::Starting;
                status.consecutive_failures = 0;
                status.last_transition_at = now;
            }
            RuntimeState::Stopped => {
                return Err(AppError::Command(format!(
                    "MCP extension `{extension_id}` runtime is stopped"
                )));
            }
            _ if control.half_open_probe.load(Ordering::Acquire) => {
                return Err(AppError::Command(format!(
                    "MCP extension `{extension_id}` automatic recovery probe is already in progress"
                )));
            }
            _ => {}
        }
    }

    if half_open_probe && let Err(error) = persist_control(extension_id, &control).await {
        control.half_open_probe.store(false, Ordering::Release);
        return Err(error);
    }

    let generation = control.generation.load(Ordering::Acquire);
    let permit = match timeout(QUEUE_TIMEOUT, control.semaphore.clone().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => {
            control.half_open_probe.store(false, Ordering::Release);
            record_failure_control(extension_id, &control, RuntimeErrorCategory::Overloaded)
                .await?;
            return Err(AppError::Command(format!(
                "MCP extension `{extension_id}` runtime limiter is unavailable"
            )));
        }
        Err(_) => {
            control.half_open_probe.store(false, Ordering::Release);
            record_failure_control(extension_id, &control, RuntimeErrorCategory::Overloaded)
                .await?;
            return Err(AppError::Command(format!(
                "MCP extension `{extension_id}` exceeded the bounded runtime queue wait"
            )));
        }
    };

    if let Err(error) =
        set_state_control(extension_id, &control, RuntimeState::Starting, None, false).await
    {
        control.half_open_probe.store(false, Ordering::Release);
        return Err(error);
    }
    Ok(RuntimeLease {
        extension_id: extension_id.to_owned(),
        generation,
        generation_ref: control.generation.clone(),
        cancel_rx: control.cancel_tx.subscribe(),
        half_open_probe,
        probe_in_flight: control.half_open_probe.clone(),
        _permit: permit,
    })
}

pub fn ensure_current(lease: &RuntimeLease) -> AppResult<()> {
    if lease.generation_ref.load(Ordering::Acquire) != lease.generation {
        return Err(AppError::Command(format!(
            "MCP extension `{}` runtime operation was cancelled by a lifecycle change",
            lease.extension_id
        )));
    }
    Ok(())
}

pub async fn reset_for_start(extension_id: &str) -> AppResult<()> {
    cancel(extension_id).await?;
    let control = control(extension_id).await?;
    control.half_open_probe.store(false, Ordering::Release);
    {
        let mut status = control.status.lock().await;
        status.state = RuntimeState::Starting;
        status.consecutive_failures = 0;
        status.last_error_category = None;
        status.last_transition_at = now_unix();
    }
    persist_control(extension_id, &control).await
}

pub async fn stop(extension_id: &str) -> AppResult<()> {
    let control = control(extension_id).await?;
    control.half_open_probe.store(false, Ordering::Release);
    advance_generation(&control);
    set_state_control(extension_id, &control, RuntimeState::Stopped, None, false).await
}

pub async fn forget(extension_id: &str) {
    controls().lock().await.remove(extension_id);
}

pub async fn cancel(extension_id: &str) -> AppResult<()> {
    let control = control(extension_id).await?;
    control.half_open_probe.store(false, Ordering::Release);
    advance_generation(&control);
    set_state_control(
        extension_id,
        &control,
        RuntimeState::Degraded,
        Some(RuntimeErrorCategory::Cancelled),
        false,
    )
    .await
}

pub async fn mark_ready(extension_id: &str) -> AppResult<()> {
    let control = control(extension_id).await?;
    control.half_open_probe.store(false, Ordering::Release);
    let now = now_unix();
    {
        let mut status = control.status.lock().await;
        status.state = RuntimeState::Ready;
        status.consecutive_failures = 0;
        status.last_error_category = None;
        status.last_transition_at = now;
        status.last_healthy_at = Some(now);
    }
    persist_control(extension_id, &control).await
}

pub async fn mark_failure(
    extension_id: &str,
    category: RuntimeErrorCategory,
) -> AppResult<RuntimeState> {
    let control = control(extension_id).await?;
    record_failure_control(extension_id, &control, category).await
}

pub async fn mark_retrying(extension_id: &str) -> AppResult<()> {
    let control = control(extension_id).await?;
    let is_terminal = control.status.lock().await.state == RuntimeState::Error;
    if is_terminal {
        return Ok(());
    }
    set_state_control(extension_id, &control, RuntimeState::Retrying, None, false).await
}

pub async fn mark_starting(extension_id: &str) -> AppResult<()> {
    let control = control(extension_id).await?;
    let state = control.status.lock().await.state;
    if matches!(state, RuntimeState::Error | RuntimeState::Stopped) {
        return Ok(());
    }
    set_state_control(extension_id, &control, RuntimeState::Starting, None, false).await
}

pub async fn wait_before_retry(lease: &RuntimeLease, completed_attempt: usize) -> AppResult<()> {
    ensure_current(lease)?;
    tokio::select! {
        _ = sleep(retry_delay(&lease.extension_id, completed_attempt)) => {}
        _ = cancellation_signal(lease) => {}
    }
    ensure_current(lease)
}

pub async fn health(pool: &SqlitePool, extension_id: &str) -> AppResult<RuntimeHealthSnapshot> {
    if let Some(control) = controls().lock().await.get(extension_id).cloned() {
        return snapshot_control(extension_id, &control).await;
    }
    let row = sqlx::query_as::<_, PersistedRuntimeHealthRow>(
        "SELECT extension_id, state, consecutive_failures, last_error_category, last_transition_at, last_healthy_at \
         FROM mcp_extension_runtime_health WHERE extension_id = ?1",
    )
    .bind(extension_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::InvalidRequest(format!(
            "MCP extension `{extension_id}` runtime health is not registered"
        ))
    })?;
    persisted_snapshot(row)
}

pub fn classify_error(error: &AppError) -> RuntimeErrorCategory {
    match error {
        AppError::InvalidRequest(_) => RuntimeErrorCategory::Configuration,
        AppError::Io(_) => RuntimeErrorCategory::Connection,
        AppError::Command(message) => {
            let message = message.to_ascii_lowercase();
            if message.contains("cancel") || message.contains("lifecycle change") {
                RuntimeErrorCategory::Cancelled
            } else if message.contains("timeout") || message.contains("timed out") {
                RuntimeErrorCategory::Timeout
            } else if message.contains("queue wait") || message.contains("limiter") {
                RuntimeErrorCategory::Overloaded
            } else if message.contains("initialize")
                || message.contains("transport")
                || message.contains("connect")
                || message.contains("connection")
            {
                RuntimeErrorCategory::Connection
            } else if message.contains("tools/list") || message.contains("protocol") {
                RuntimeErrorCategory::Protocol
            } else if message.contains("tools/call") || message.contains("downstream") {
                RuntimeErrorCategory::Downstream
            } else {
                RuntimeErrorCategory::Unknown
            }
        }
        _ => RuntimeErrorCategory::Unknown,
    }
}

pub fn is_runtime_circuit_open_error(error: &AppError) -> bool {
    matches!(
        error,
        AppError::Command(message)
            if message
                .to_ascii_lowercase()
                .contains("runtime circuit is open")
    )
}

pub fn is_fail_closed_error(error: &AppError) -> bool {
    matches!(
        error,
        AppError::Command(message)
            if message
                .to_ascii_lowercase()
                .contains("fail-closed after repeated failures")
    )
}

pub fn audit_error_category(
    error: &AppError,
    last_error_category: Option<RuntimeErrorCategory>,
) -> String {
    if is_runtime_circuit_open_error(error) {
        return last_error_category.map_or_else(
            || "runtime-circuit-open".to_owned(),
            |category| format!("runtime-circuit-open:{}", category.as_str()),
        );
    }
    if is_fail_closed_error(error) {
        return last_error_category.map_or_else(
            || "runtime-fail-closed".to_owned(),
            |category| format!("runtime-fail-closed:{}", category.as_str()),
        );
    }
    classify_error(error).as_str().to_owned()
}

fn advance_generation(control: &RuntimeControl) {
    let generation = control.generation.fetch_add(1, Ordering::AcqRel) + 1;
    control.cancel_tx.send_replace(generation);
}

async fn record_failure_control(
    extension_id: &str,
    control: &RuntimeControl,
    category: RuntimeErrorCategory,
) -> AppResult<RuntimeState> {
    let state = {
        let mut status = control.status.lock().await;
        if status.state == RuntimeState::Stopped {
            return Ok(RuntimeState::Stopped);
        }
        status.last_error_category = Some(category);
        if category.counts_toward_circuit_breaker() {
            status.consecutive_failures = status.consecutive_failures.saturating_add(1);
            status.state = if status.consecutive_failures >= MAX_CONNECT_ATTEMPTS as u32 {
                RuntimeState::Error
            } else {
                RuntimeState::Degraded
            };
        } else {
            status.state = RuntimeState::Degraded;
        }
        status.last_transition_at = now_unix();
        status.state
    };
    persist_control(extension_id, control).await?;
    Ok(state)
}

async fn set_state_control(
    extension_id: &str,
    control: &RuntimeControl,
    state: RuntimeState,
    category: Option<RuntimeErrorCategory>,
    reset_failures: bool,
) -> AppResult<()> {
    {
        let mut status = control.status.lock().await;
        status.state = state;
        if reset_failures {
            status.consecutive_failures = 0;
        }
        if category.is_some() {
            status.last_error_category = category;
        }
        status.last_transition_at = now_unix();
    }
    persist_control(extension_id, control).await
}

async fn cancellation_signal(lease: &RuntimeLease) {
    let mut receiver = lease.cancel_rx.clone();
    loop {
        if *receiver.borrow() != lease.generation {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn persist_control(extension_id: &str, control: &RuntimeControl) -> AppResult<()> {
    let Some(pool) = RUNTIME_DB.get() else {
        return Ok(());
    };
    let snapshot = snapshot_control(extension_id, control).await?;
    persist_snapshot(pool, &snapshot).await
}

async fn persist_snapshot(pool: &SqlitePool, snapshot: &RuntimeHealthSnapshot) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO mcp_extension_runtime_health(\
            extension_id, state, consecutive_failures, last_error_category, last_transition_at, last_healthy_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(extension_id) DO UPDATE SET \
            state = excluded.state, \
            consecutive_failures = excluded.consecutive_failures, \
            last_error_category = excluded.last_error_category, \
            last_transition_at = excluded.last_transition_at, \
            last_healthy_at = excluded.last_healthy_at",
    )
    .bind(&snapshot.extension_id)
    .bind(snapshot.state.as_str())
    .bind(i64::from(snapshot.consecutive_failures))
    .bind(snapshot.last_error_category.map(RuntimeErrorCategory::as_str))
    .bind(snapshot.last_transition_at)
    .bind(snapshot.last_healthy_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn snapshot_control(
    extension_id: &str,
    control: &RuntimeControl,
) -> AppResult<RuntimeHealthSnapshot> {
    let status = control.status.lock().await.clone();
    Ok(RuntimeHealthSnapshot {
        extension_id: extension_id.to_owned(),
        state: status.state,
        consecutive_failures: status.consecutive_failures,
        in_flight: MAX_IN_FLIGHT_PER_EXTENSION
            .saturating_sub(control.semaphore.available_permits()),
        generation: control.generation.load(Ordering::Acquire),
        last_error_category: status.last_error_category,
        last_transition_at: status.last_transition_at,
        last_healthy_at: status.last_healthy_at,
    })
}

fn persisted_snapshot(row: PersistedRuntimeHealthRow) -> AppResult<RuntimeHealthSnapshot> {
    let consecutive_failures = u32::try_from(row.consecutive_failures).map_err(|_| {
        AppError::Command(format!(
            "invalid persisted MCP runtime failure count for `{}`",
            row.extension_id
        ))
    })?;
    let last_error_category = row
        .last_error_category
        .as_deref()
        .map(RuntimeErrorCategory::parse)
        .transpose()?;
    Ok(RuntimeHealthSnapshot {
        extension_id: row.extension_id,
        state: RuntimeState::parse(&row.state)?,
        consecutive_failures,
        in_flight: 0,
        generation: 0,
        last_error_category,
        last_transition_at: row.last_transition_at,
        last_healthy_at: row.last_healthy_at,
    })
}

async fn load_persisted_status(
    pool: &SqlitePool,
    extension_id: &str,
) -> AppResult<Option<RuntimeStatus>> {
    let row = sqlx::query_as::<_, PersistedRuntimeHealthRow>(
        "SELECT extension_id, state, consecutive_failures, last_error_category, last_transition_at, last_healthy_at \
         FROM mcp_extension_runtime_health WHERE extension_id = ?1",
    )
    .bind(extension_id)
    .fetch_optional(pool)
    .await?;
    row.map(persisted_snapshot).transpose().map(|snapshot| {
        snapshot.map(|snapshot| RuntimeStatus {
            state: snapshot.state,
            consecutive_failures: snapshot.consecutive_failures,
            last_error_category: snapshot.last_error_category,
            last_transition_at: snapshot.last_transition_at,
            last_healthy_at: snapshot.last_healthy_at,
        })
    })
}

fn retry_delay(extension_id: &str, completed_attempt: usize) -> Duration {
    let exponent = completed_attempt.min(4) as u32;
    let base = BASE_BACKOFF_MS
        .saturating_mul(1_u64 << exponent)
        .min(MAX_BACKOFF_MS);
    let seed = extension_id
        .bytes()
        .fold(completed_attempt as u64 + 17, |acc, byte| {
            acc.wrapping_mul(33).wrapping_add(byte as u64)
        });
    Duration::from_millis(base + seed % (MAX_JITTER_MS + 1))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_stop_invalidates_backoff_and_marks_stopped() {
        let id = "runtime-stop-test";
        reset_for_start(id).await.expect("reset");
        let lease = acquire(id).await.expect("acquire lease");
        ensure_current(&lease).expect("lease starts current");
        let waiting = tokio::spawn(async move { wait_before_retry(&lease, 0).await });
        sleep(Duration::from_millis(20)).await;
        stop(id).await.expect("stop");
        assert!(waiting.await.expect("join").is_err());
        assert_eq!(health_without_db(id).await.state, RuntimeState::Stopped);
        forget(id).await;
    }

    #[tokio::test]
    async fn repeated_transport_failures_open_circuit_then_auto_half_open() {
        let id = "runtime-circuit-test";
        reset_for_start(id).await.expect("reset");
        for _ in 0..MAX_CONNECT_ATTEMPTS {
            mark_failure(id, RuntimeErrorCategory::Connection)
                .await
                .expect("failure");
        }
        let snapshot = health_without_db(id).await;
        assert_eq!(snapshot.state, RuntimeState::Error);
        assert_eq!(snapshot.consecutive_failures, MAX_CONNECT_ATTEMPTS as u32);
        let blocked = match acquire(id).await {
            Ok(_) => panic!("circuit must remain open during cooldown"),
            Err(error) => error,
        };
        assert!(blocked.to_string().contains("automatic recovery probe"));

        let control = control(id).await.expect("control");
        control.status.lock().await.last_transition_at =
            now_unix().saturating_sub(CIRCUIT_OPEN_COOLDOWN.as_secs() as i64 + 1);
        let lease = acquire(id).await.expect("half-open probe after cooldown");
        assert!(control.half_open_probe.load(Ordering::Acquire));
        mark_ready(id).await.expect("probe recovers runtime");
        drop(lease);
        let recovered = health_without_db(id).await;
        assert_eq!(recovered.state, RuntimeState::Ready);
        assert_eq!(recovered.consecutive_failures, 0);
        forget(id).await;
    }

    #[tokio::test]
    async fn downstream_failures_do_not_open_transport_circuit() {
        let id = "runtime-downstream-error-test";
        reset_for_start(id).await.expect("reset");
        for _ in 0..(MAX_CONNECT_ATTEMPTS * 2) {
            mark_failure(id, RuntimeErrorCategory::Downstream)
                .await
                .expect("downstream failure");
        }
        let snapshot = health_without_db(id).await;
        assert_eq!(snapshot.state, RuntimeState::Degraded);
        assert_eq!(snapshot.consecutive_failures, 0);
        drop(
            acquire(id)
                .await
                .expect("downstream errors do not brick runtime"),
        );
        forget(id).await;
    }

    #[tokio::test]
    async fn half_open_recovery_allows_only_one_probe() {
        let id = "runtime-half-open-single-probe-test";
        reset_for_start(id).await.expect("reset");
        for _ in 0..MAX_CONNECT_ATTEMPTS {
            mark_failure(id, RuntimeErrorCategory::Connection)
                .await
                .expect("failure");
        }
        let control = control(id).await.expect("control");
        control.status.lock().await.last_transition_at =
            now_unix().saturating_sub(CIRCUIT_OPEN_COOLDOWN.as_secs() as i64 + 1);
        let probe = acquire(id).await.expect("first half-open probe");
        let competing = match acquire(id).await {
            Ok(_) => panic!("second half-open probe must be rejected"),
            Err(error) => error,
        };
        assert!(
            competing
                .to_string()
                .contains("probe is already in progress")
        );
        drop(probe);
        forget(id).await;
    }

    #[test]
    fn circuit_open_audit_category_preserves_the_previous_runtime_failure() {
        let error = AppError::Command(
            "MCP extension `memory` runtime circuit is open after repeated transport failures; automatic recovery probe available in 10s"
                .to_owned(),
        );

        assert!(is_runtime_circuit_open_error(&error));
        assert_eq!(
            audit_error_category(&error, Some(RuntimeErrorCategory::Connection)),
            "runtime-circuit-open:connection"
        );
        assert_eq!(audit_error_category(&error, None), "runtime-circuit-open");
    }

    #[tokio::test]
    async fn per_extension_concurrency_is_bounded() {
        let id = "runtime-limit-test";
        reset_for_start(id).await.expect("reset");
        let mut leases = Vec::new();
        for _ in 0..MAX_IN_FLIGHT_PER_EXTENSION {
            leases.push(acquire(id).await.expect("bounded lease"));
        }
        assert_eq!(
            health_without_db(id).await.in_flight,
            MAX_IN_FLIGHT_PER_EXTENSION
        );

        let blocked = timeout(Duration::from_millis(50), acquire(id)).await;
        assert!(blocked.is_err(), "fifth call must wait for capacity");
        leases.pop();
        let replacement = timeout(Duration::from_secs(1), acquire(id))
            .await
            .expect("capacity released")
            .expect("replacement lease");
        drop(replacement);
        drop(leases);
        forget(id).await;
    }

    #[test]
    fn retry_backoff_is_bounded_and_increases() {
        let first = retry_delay("memory", 0);
        let second = retry_delay("memory", 1);
        let late = retry_delay("memory", 20);
        assert!(first >= Duration::from_millis(BASE_BACKOFF_MS));
        assert!(second > first);
        assert!(late <= Duration::from_millis(MAX_BACKOFF_MS + MAX_JITTER_MS));
    }

    async fn health_without_db(extension_id: &str) -> RuntimeHealthSnapshot {
        let control = control(extension_id).await.expect("control");
        snapshot_control(extension_id, &control)
            .await
            .expect("snapshot")
    }
}
