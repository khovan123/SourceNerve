use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

use crate::error::{AppError, AppResult};

pub const MAX_CONNECT_ATTEMPTS: usize = 3;
pub const MAX_IN_FLIGHT_PER_EXTENSION: usize = 4;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const BASE_BACKOFF_MS: u64 = 200;
const MAX_BACKOFF_MS: u64 = 2_000;
const MAX_JITTER_MS: u64 = 100;

#[derive(Clone)]
struct RuntimeControl {
    generation: Arc<AtomicU64>,
    semaphore: Arc<Semaphore>,
}

pub struct RuntimeLease {
    extension_id: String,
    generation: u64,
    generation_ref: Arc<AtomicU64>,
    _permit: OwnedSemaphorePermit,
}

static RUNTIME_CONTROLS: OnceLock<Mutex<HashMap<String, RuntimeControl>>> = OnceLock::new();

fn controls() -> &'static Mutex<HashMap<String, RuntimeControl>> {
    RUNTIME_CONTROLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn new_control() -> RuntimeControl {
    RuntimeControl {
        generation: Arc::new(AtomicU64::new(0)),
        semaphore: Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_EXTENSION)),
    }
}

async fn control(extension_id: &str) -> RuntimeControl {
    let mut controls = controls().lock().await;
    controls
        .entry(extension_id.to_owned())
        .or_insert_with(new_control)
        .clone()
}

pub async fn acquire(extension_id: &str) -> AppResult<RuntimeLease> {
    let control = control(extension_id).await;
    let generation = control.generation.load(Ordering::Acquire);
    let permit = timeout(QUEUE_TIMEOUT, control.semaphore.acquire_owned())
        .await
        .map_err(|_| {
            AppError::Command(format!(
                "MCP extension `{extension_id}` exceeded the bounded runtime queue wait"
            ))
        })?
        .map_err(|_| {
            AppError::Command(format!(
                "MCP extension `{extension_id}` runtime limiter is unavailable"
            ))
        })?;
    Ok(RuntimeLease {
        extension_id: extension_id.to_owned(),
        generation,
        generation_ref: control.generation,
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

pub async fn cancel(extension_id: &str) {
    let control = control(extension_id).await;
    control.generation.fetch_add(1, Ordering::AcqRel);
}

pub async fn wait_before_retry(lease: &RuntimeLease, completed_attempt: usize) -> AppResult<()> {
    ensure_current(lease)?;
    tokio::time::sleep(retry_delay(&lease.extension_id, completed_attempt)).await;
    ensure_current(lease)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_cancel_invalidates_existing_runtime_lease() {
        let lease = acquire("runtime-cancel-test").await.expect("acquire lease");
        ensure_current(&lease).expect("lease starts current");
        cancel("runtime-cancel-test").await;
        assert!(ensure_current(&lease).is_err());
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
}
