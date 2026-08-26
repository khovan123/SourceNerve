use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    oauth::Principal,
};

const DEFAULT_ACTIVITY_LIMIT: u32 = 100;
const MAX_ACTIVITY_LIMIT: u32 = 500;
const RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_RETAINED_ROWS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Blocked,
    Ask,
    AuthorizationDenied,
    ConfigurationError,
}

impl PolicyDecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Blocked => "blocked",
            Self::Ask => "ask",
            Self::AuthorizationDenied => "authorization-denied",
            Self::ConfigurationError => "configuration-error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    NotRequired,
    Approved,
    Missing,
    NotApplicable,
}

impl ApprovalDecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not-required",
            Self::Approved => "approved",
            Self::Missing => "missing",
            Self::NotApplicable => "not-applicable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultCategory {
    Success,
    Denied,
    ApprovalRequired,
    ConfigurationError,
    DownstreamError,
}

impl ResultCategory {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Denied => "denied",
            Self::ApprovalRequired => "approval-required",
            Self::ConfigurationError => "configuration-error",
            Self::DownstreamError => "downstream-error",
        }
    }
}

#[derive(Debug)]
pub struct AuditEvent<'a> {
    pub principal: &'a Principal,
    pub workspace_id: Option<&'a str>,
    pub extension_id: &'a str,
    pub extension_version: &'a str,
    pub public_tool: &'a str,
    pub original_tool: &'a str,
    pub schema_hash: &'a str,
    pub policy_decision: PolicyDecision,
    pub approval_decision: ApprovalDecision,
    pub result_category: ResultCategory,
    pub duration_ms: u64,
    pub error_category: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityRecord {
    pub id: i64,
    pub occurred_at: i64,
    pub principal_kind: String,
    pub principal_subject: String,
    pub workspace_id: Option<String>,
    pub extension_id: String,
    pub extension_version: String,
    pub public_tool: String,
    pub original_tool: String,
    pub schema_hash: String,
    pub policy_decision: String,
    pub approval_decision: String,
    pub result_category: String,
    pub duration_ms: u64,
    pub error_category: Option<String>,
}

pub async fn record(pool: &SqlitePool, event: AuditEvent<'_>) -> AppResult<()> {
    validate_event(&event)?;
    let (principal_kind, principal_subject) = principal_identity(event.principal);
    sqlx::query(
        "INSERT INTO mcp_extension_invocation_audit(\
            principal_kind, principal_subject, workspace_id, extension_id, extension_version, \
            public_tool, original_tool, schema_hash, policy_decision, approval_decision, \
            result_category, duration_ms, error_category\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(principal_kind)
    .bind(principal_subject)
    .bind(event.workspace_id)
    .bind(event.extension_id)
    .bind(event.extension_version)
    .bind(event.public_tool)
    .bind(event.original_tool)
    .bind(event.schema_hash)
    .bind(event.policy_decision.as_str())
    .bind(event.approval_decision.as_str())
    .bind(event.result_category.as_str())
    .bind(i64::try_from(event.duration_ms).unwrap_or(i64::MAX))
    .bind(event.error_category)
    .execute(pool)
    .await?;
    prune(pool).await?;
    Ok(())
}

pub async fn list(
    pool: &SqlitePool,
    extension_id: Option<&str>,
    limit: Option<u32>,
) -> AppResult<Vec<ActivityRecord>> {
    if let Some(extension_id) = extension_id
        && !safe_text(extension_id, 64)
    {
        return Err(AppError::InvalidRequest(
            "invalid MCP activity extension filter".into(),
        ));
    }
    let limit = limit
        .unwrap_or(DEFAULT_ACTIVITY_LIMIT)
        .clamp(1, MAX_ACTIVITY_LIMIT);
    let rows = if let Some(extension_id) = extension_id {
        sqlx::query(
            "SELECT id, occurred_at, principal_kind, principal_subject, workspace_id, extension_id, \
                    extension_version, public_tool, original_tool, schema_hash, policy_decision, \
                    approval_decision, result_category, duration_ms, error_category \
             FROM mcp_extension_invocation_audit WHERE extension_id = ?1 \
             ORDER BY occurred_at DESC, id DESC LIMIT ?2",
        )
        .bind(extension_id)
        .bind(i64::from(limit))
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, occurred_at, principal_kind, principal_subject, workspace_id, extension_id, \
                    extension_version, public_tool, original_tool, schema_hash, policy_decision, \
                    approval_decision, result_category, duration_ms, error_category \
             FROM mcp_extension_invocation_audit ORDER BY occurred_at DESC, id DESC LIMIT ?1",
        )
        .bind(i64::from(limit))
        .fetch_all(pool)
        .await?
    };
    rows.into_iter().map(activity_from_row).collect()
}

pub async fn clear_expired(pool: &SqlitePool) -> AppResult<u64> {
    let result = sqlx::query(
        "DELETE FROM mcp_extension_invocation_audit WHERE occurred_at < unixepoch() - ?1",
    )
    .bind(RETENTION_SECONDS)
    .execute(pool)
    .await?;
    prune_row_cap(pool).await?;
    Ok(result.rows_affected())
}

async fn prune(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM mcp_extension_invocation_audit WHERE occurred_at < unixepoch() - ?1")
        .bind(RETENTION_SECONDS)
        .execute(pool)
        .await?;
    prune_row_cap(pool).await
}

async fn prune_row_cap(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM mcp_extension_invocation_audit WHERE id IN (\
            SELECT id FROM mcp_extension_invocation_audit \
            ORDER BY occurred_at DESC, id DESC LIMIT -1 OFFSET ?1\
         )",
    )
    .bind(MAX_RETAINED_ROWS)
    .execute(pool)
    .await?;
    Ok(())
}

fn principal_identity(principal: &Principal) -> (&'static str, &str) {
    match principal {
        Principal::Operator => ("operator", "operator"),
        Principal::OAuth(principal) => ("oauth", principal.subject.as_ref()),
    }
}

fn validate_event(event: &AuditEvent<'_>) -> AppResult<()> {
    if !safe_optional_text(event.workspace_id, 128)
        || !safe_text(event.extension_id, 64)
        || !safe_text(event.extension_version, 64)
        || !safe_text(event.public_tool, 120)
        || !safe_text(event.original_tool, 128)
        || !safe_text(event.schema_hash, 128)
        || !safe_optional_text(event.error_category, 64)
    {
        return Err(AppError::InvalidRequest(
            "MCP invocation audit metadata is invalid".into(),
        ));
    }
    Ok(())
}

fn safe_optional_text(value: Option<&str>, max: usize) -> bool {
    value.is_none_or(|value| safe_text(value, max))
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|ch| !ch.is_control() && !matches!(ch, '\r' | '\n' | '\0'))
}

fn activity_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<ActivityRecord> {
    let duration_ms: i64 = row.try_get("duration_ms")?;
    Ok(ActivityRecord {
        id: row.try_get("id")?,
        occurred_at: row.try_get("occurred_at")?,
        principal_kind: row.try_get("principal_kind")?,
        principal_subject: row.try_get("principal_subject")?,
        workspace_id: row.try_get("workspace_id")?,
        extension_id: row.try_get("extension_id")?,
        extension_version: row.try_get("extension_version")?,
        public_tool: row.try_get("public_tool")?,
        original_tool: row.try_get("original_tool")?,
        schema_hash: row.try_get("schema_hash")?,
        policy_decision: row.try_get("policy_decision")?,
        approval_decision: row.try_get("approval_decision")?,
        result_category: row.try_get("result_category")?,
        duration_ms: u64::try_from(duration_ms).unwrap_or_default(),
        error_category: row.try_get("error_category")?,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[tokio::test]
    async fn persists_success_ask_blocked_and_downstream_error_metadata() {
        let fixture = tempfile::tempdir().expect("fixture");
        let pool = crate::db::connect(&fixture.path().join("state"))
            .await
            .expect("database");
        let principal = Principal::Operator;
        let scenarios = [
            (
                PolicyDecision::Allow,
                ApprovalDecision::NotRequired,
                ResultCategory::Success,
                None,
            ),
            (
                PolicyDecision::Ask,
                ApprovalDecision::Missing,
                ResultCategory::ApprovalRequired,
                None,
            ),
            (
                PolicyDecision::Blocked,
                ApprovalDecision::NotApplicable,
                ResultCategory::Denied,
                None,
            ),
            (
                PolicyDecision::Allow,
                ApprovalDecision::Approved,
                ResultCategory::DownstreamError,
                Some("transport"),
            ),
        ];

        for (index, (policy, approval, result, error_category)) in scenarios.into_iter().enumerate()
        {
            record(
                &pool,
                AuditEvent {
                    principal: &principal,
                    workspace_id: Some("workspace-a"),
                    extension_id: "memory",
                    extension_version: "1.2.3",
                    public_tool: "memory__search",
                    original_tool: "search",
                    schema_hash: "schema-abc",
                    policy_decision: policy,
                    approval_decision: approval,
                    result_category: result,
                    duration_ms: 10 + index as u64,
                    error_category,
                },
            )
            .await
            .expect("record audit event");
        }

        let records = list(&pool, Some("memory"), Some(10))
            .await
            .expect("list activity");
        assert_eq!(records.len(), 4);
        let results = records
            .iter()
            .map(|record| record.result_category.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            results,
            BTreeSet::from(["approval-required", "denied", "downstream-error", "success",])
        );
        assert!(
            records
                .iter()
                .all(|record| record.principal_kind == "operator")
        );
        assert!(
            records
                .iter()
                .all(|record| record.workspace_id.as_deref() == Some("workspace-a"))
        );
        assert!(
            records
                .iter()
                .any(|record| record.approval_decision == "approved")
        );
    }

    #[tokio::test]
    async fn persistent_activity_schema_is_metadata_only_and_excludes_secret_payload_columns() {
        let fixture = tempfile::tempdir().expect("fixture");
        let pool = crate::db::connect(&fixture.path().join("state"))
            .await
            .expect("database");
        let rows = sqlx::query("PRAGMA table_info(mcp_extension_invocation_audit)")
            .fetch_all(&pool)
            .await
            .expect("audit table schema");
        let columns = rows
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<BTreeSet<_>>();

        for forbidden in [
            "arguments",
            "result",
            "payload",
            "authorization",
            "credential",
            "access_token",
            "refresh_token",
            "api_key",
            "secret",
        ] {
            assert!(
                !columns.contains(forbidden),
                "raw sensitive column `{forbidden}` must not exist in MCP invocation audit storage"
            );
        }
        for required in [
            "principal_subject",
            "extension_id",
            "public_tool",
            "policy_decision",
            "approval_decision",
            "result_category",
            "duration_ms",
        ] {
            assert!(
                columns.contains(required),
                "missing safe metadata column `{required}`"
            );
        }
    }

    #[tokio::test]
    async fn activity_query_is_bounded_and_filterable() {
        let fixture = tempfile::tempdir().expect("fixture");
        let pool = crate::db::connect(&fixture.path().join("state"))
            .await
            .expect("database");
        let principal = Principal::Operator;
        for extension_id in ["one", "two"] {
            record(
                &pool,
                AuditEvent {
                    principal: &principal,
                    workspace_id: None,
                    extension_id,
                    extension_version: "1.0.0",
                    public_tool: "public__tool",
                    original_tool: "tool",
                    schema_hash: "schema",
                    policy_decision: PolicyDecision::Allow,
                    approval_decision: ApprovalDecision::NotRequired,
                    result_category: ResultCategory::Success,
                    duration_ms: 1,
                    error_category: None,
                },
            )
            .await
            .expect("record");
        }

        assert_eq!(list(&pool, None, Some(1)).await.expect("bounded").len(), 1);
        let filtered = list(&pool, Some("two"), Some(500)).await.expect("filtered");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].extension_id, "two");
        assert!(list(&pool, Some("bad\nfilter"), Some(1)).await.is_err());
    }

    #[test]
    fn audit_text_rejects_control_characters_and_unbounded_values() {
        assert!(safe_text("extension-1", 64));
        assert!(!safe_text("token\nleak", 64));
        assert!(!safe_text(&"x".repeat(65), 64));
    }
}
