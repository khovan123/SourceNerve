use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{coordination, db, service::AppState, workspace::WorkspaceRegistry};

async fn states() -> (tempfile::TempDir, AppState, AppState) {
    let state_dir = tempfile::tempdir().expect("state tempdir");
    let registry = WorkspaceRegistry::build(&[]).expect("empty registry");
    let first_pool = db::connect(state_dir.path()).await.expect("first db");
    let second_pool = db::connect(state_dir.path()).await.expect("second db");
    let first = AppState {
        workspaces: registry.clone(),
        db: first_pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    let second = AppState {
        workspaces: registry,
        db: second_pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    (state_dir, first, second)
}

#[tokio::test]
async fn one_writer_per_resource_but_distinct_resources_can_progress() {
    let (_state_dir, first, second) = states().await;
    let first_lease = coordination::acquire(&first, "workspace-a")
        .await
        .expect("first lease");
    first_lease.assert_current().await.expect("current lease");
    first_lease.renew().await.expect("renew lease");
    assert!(first_lease.fencing_token() >= 1);

    let contention = coordination::acquire(&second, "workspace-a").await;
    assert!(contention.is_err(), "second writer must be rejected");

    let other = coordination::acquire(&second, "workspace-b")
        .await
        .expect("different resource lease");
    other.assert_current().await.expect("other lease current");
}

#[tokio::test]
async fn expired_holder_is_fenced_after_takeover() {
    let (_state_dir, first, second) = states().await;
    let stale = coordination::acquire(&first, "workspace-a")
        .await
        .expect("stale lease");
    let old_token = stale.fencing_token();

    sqlx::query(
        "UPDATE mutation_leases SET expires_at=unixepoch()-1 WHERE resource_key='workspace-a'",
    )
    .execute(&first.db)
    .await
    .expect("expire first lease");

    let replacement = coordination::acquire(&second, "workspace-a")
        .await
        .expect("replacement lease");
    assert!(replacement.fencing_token() > old_token);
    replacement
        .assert_current()
        .await
        .expect("replacement current");
    assert!(
        stale.assert_current().await.is_err(),
        "expired holder must fail its fence check"
    );
}

#[tokio::test]
async fn readiness_exposes_counts_without_instance_identity() {
    let (_state_dir, first, _second) = states().await;
    let lease = coordination::acquire(&first, "workspace-a")
        .await
        .expect("lease");
    let status = coordination::status(&first).await;
    assert_eq!(status.mode, "sqlite-fenced-leases");
    assert_eq!(status.active_leases, 1);
    assert_eq!(status.owned_leases, 1);
    let encoded = serde_json::to_string(&status).expect("serialize status");
    assert!(!encoded.contains("instance"));
    assert!(!encoded.contains("lease_id"));
    drop(lease);
}
