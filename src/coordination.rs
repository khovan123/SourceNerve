use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use schemars::JsonSchema;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

const LEASE_TTL_SECONDS: i64 = 30;
const LEASE_RENEW_SECONDS: u64 = 10;

static INSTANCE_IDS: OnceLock<Mutex<HashMap<usize, Arc<String>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CoordinationStatus {
    pub mode: &'static str,
    pub active_leases: i64,
    pub owned_leases: i64,
}

pub struct MutationLease {
    db: SqlitePool,
    resource_key: String,
    instance_id: Arc<String>,
    lease_id: String,
    fencing_token: i64,
    renew_task: JoinHandle<()>,
}

fn busy(resource: &str) -> AppError {
    AppError::InvalidRequest(format!("mutation resource is busy: {resource}"))
}

fn lost(resource: &str) -> AppError {
    AppError::InvalidRequest(format!("mutation lease was lost: {resource}"))
}

impl MutationLease {
    #[cfg(test)]
    pub fn fencing_token(&self) -> i64 {
        self.fencing_token
    }

    pub async fn assert_current(&self) -> AppResult<()> {
        let current: Option<i64> = sqlx::query_scalar(
            "SELECT fencing_token FROM mutation_leases \
             WHERE resource_key=?1 AND owner_instance_id=?2 AND lease_id=?3 \
               AND fencing_token=?4 AND expires_at > unixepoch()",
        )
        .bind(&self.resource_key)
        .bind(self.instance_id.as_str())
        .bind(&self.lease_id)
        .bind(self.fencing_token)
        .fetch_optional(&self.db)
        .await?;
        if current == Some(self.fencing_token) {
            Ok(())
        } else {
            Err(lost(&self.resource_key))
        }
    }

    #[cfg(test)]
    pub async fn renew(&self) -> AppResult<()> {
        let result = sqlx::query(
            "UPDATE mutation_leases SET renewed_at=unixepoch(), expires_at=unixepoch()+?1 \
             WHERE resource_key=?2 AND owner_instance_id=?3 AND lease_id=?4 \
               AND fencing_token=?5 AND expires_at > unixepoch()",
        )
        .bind(LEASE_TTL_SECONDS)
        .bind(&self.resource_key)
        .bind(self.instance_id.as_str())
        .bind(&self.lease_id)
        .bind(self.fencing_token)
        .execute(&self.db)
        .await?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(lost(&self.resource_key))
        }
    }
}

impl Drop for MutationLease {
    fn drop(&mut self) {
        self.renew_task.abort();
        let db = self.db.clone();
        let resource_key = self.resource_key.clone();
        let instance_id = self.instance_id.clone();
        let lease_id = self.lease_id.clone();
        let fencing_token = self.fencing_token;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = sqlx::query(
                    "UPDATE mutation_leases \
                     SET owner_instance_id=NULL, lease_id=NULL, renewed_at=unixepoch(), expires_at=0 \
                     WHERE resource_key=?1 AND owner_instance_id=?2 AND lease_id=?3 AND fencing_token=?4",
                )
                .bind(resource_key)
                .bind(instance_id.as_str())
                .bind(lease_id)
                .bind(fencing_token)
                .execute(&db)
                .await;
            });
        }
    }
}

pub fn new_instance_id() -> Arc<String> {
    Arc::new(Uuid::new_v4().to_string())
}

fn instance_id(state: &AppState) -> Arc<String> {
    let key = Arc::as_ptr(&state.mutation_lock) as usize;
    let registry = INSTANCE_IDS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.entry(key).or_insert_with(new_instance_id).clone()
}

pub async fn acquire(state: &AppState, resource_key: &str) -> AppResult<MutationLease> {
    if resource_key.is_empty()
        || resource_key.len() > 256
        || resource_key.chars().any(char::is_control)
    {
        return Err(AppError::InvalidRequest(
            "mutation resource key must be 1-256 non-control characters".into(),
        ));
    }
    let owner = instance_id(state);
    let lease_id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO mutation_leases(\
            resource_key, owner_instance_id, lease_id, fencing_token, acquired_at, renewed_at, expires_at\
         ) VALUES(?1, ?2, ?3, 1, unixepoch(), unixepoch(), unixepoch()+?4) \
         ON CONFLICT(resource_key) DO UPDATE SET \
            owner_instance_id=excluded.owner_instance_id, \
            lease_id=excluded.lease_id, \
            fencing_token=mutation_leases.fencing_token+1, \
            acquired_at=unixepoch(), renewed_at=unixepoch(), expires_at=unixepoch()+?4 \
         WHERE mutation_leases.lease_id IS NULL OR mutation_leases.expires_at <= unixepoch()",
    )
    .bind(resource_key)
    .bind(owner.as_str())
    .bind(&lease_id)
    .bind(LEASE_TTL_SECONDS)
    .execute(&state.db)
    .await?;
    if result.rows_affected() != 1 {
        crate::observability::observe_coordination("conflict");
        return Err(busy(resource_key));
    }
    let fencing_token: i64 = sqlx::query_scalar(
        "SELECT fencing_token FROM mutation_leases \
         WHERE resource_key=?1 AND owner_instance_id=?2 AND lease_id=?3",
    )
    .bind(resource_key)
    .bind(owner.as_str())
    .bind(&lease_id)
    .fetch_one(&state.db)
    .await?;

    let db = state.db.clone();
    let renew_resource = resource_key.to_string();
    let renew_instance = owner.clone();
    let renew_lease = lease_id.clone();
    let renew_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(LEASE_RENEW_SECONDS));
        interval.tick().await;
        loop {
            interval.tick().await;
            let result = sqlx::query(
                "UPDATE mutation_leases SET renewed_at=unixepoch(), expires_at=unixepoch()+?1 \
                 WHERE resource_key=?2 AND owner_instance_id=?3 AND lease_id=?4 \
                   AND fencing_token=?5 AND expires_at > unixepoch()",
            )
            .bind(LEASE_TTL_SECONDS)
            .bind(&renew_resource)
            .bind(renew_instance.as_str())
            .bind(&renew_lease)
            .bind(fencing_token)
            .execute(&db)
            .await;
            match result {
                Ok(done) if done.rows_affected() == 1 => {}
                _ => break,
            }
        }
    });

    crate::observability::observe_coordination("success");
    Ok(MutationLease {
        db: state.db.clone(),
        resource_key: resource_key.to_string(),
        instance_id: owner,
        lease_id,
        fencing_token,
        renew_task,
    })
}

pub async fn status(state: &AppState) -> CoordinationStatus {
    let owner = instance_id(state);
    let active_leases = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM mutation_leases WHERE lease_id IS NOT NULL AND expires_at > unixepoch()",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let owned_leases = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM mutation_leases \
         WHERE lease_id IS NOT NULL AND expires_at > unixepoch() AND owner_instance_id=?1",
    )
    .bind(owner.as_str())
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    CoordinationStatus {
        mode: "sqlite-fenced-leases",
        active_leases,
        owned_leases,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_ids_are_opaque_and_unique() {
        let one = new_instance_id();
        let two = new_instance_id();
        assert_ne!(one, two);
        assert_eq!(one.len(), 36);
        assert!(!one.contains('/'));
    }
}
