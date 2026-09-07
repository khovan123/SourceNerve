use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

use super::HarnessRunIdRequest;

const MAX_QUERY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessContextRouteRequest {
    pub workspace: String,
    pub run_id: Option<String>,
    pub query: String,
    #[serde(default)]
    pub start_cycle: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessContextRouteResult {
    pub workspace: String,
    pub retrieve: bool,
    pub route: String,
    pub search_query: String,
    pub reason: String,
    pub surfaces: Vec<String>,
    pub work_shape: String,
    pub work_scope: Option<String>,
    pub selected_proof_type: Option<String>,
    pub selected_proof_source: Option<String>,
    pub selected_proof_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Decision {
    retrieve: bool,
    route: &'static str,
    reason: &'static str,
    surfaces: &'static [&'static str],
}

pub async fn route(
    state: &AppState,
    request: HarnessContextRouteRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessContextRouteResult> {
    let workspace = state.workspaces.get(&request.workspace)?;
    let query = request.query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest(format!(
            "harness context query must be 1-{MAX_QUERY_BYTES} non-control UTF-8 bytes"
        )));
    }

    if let Some(run_id) = request.run_id.as_deref() {
        let snapshot = super::get(
            state,
            HarnessRunIdRequest {
                run_id: run_id.to_string(),
            },
            principal_id,
            operator,
        )
        .await?;
        if snapshot.run.workspace != request.workspace {
            return Err(AppError::InvalidRequest(
                "harness context route workspace does not match run workspace".into(),
            ));
        }
        if snapshot.run.status != "running" || snapshot.freshness.state != "current" {
            return Err(AppError::InvalidRequest(format!(
                "harness context route requires a current running run: {run_id}"
            )));
        }
    }

    let decision = classify(query);
    let work_shape = classify_work_shape(query).to_string();
    let repository_context = super::repository_context::discover(&workspace.root);
    let work_scope = infer_work_scope(query, &repository_context);
    let selected_candidate = if request.start_cycle {
        super::repository_context::select_proof_candidate(
            &work_shape,
            &repository_context,
            work_scope.as_deref(),
        )
    } else {
        None
    };
    let selected_proof_type = selected_candidate
        .map(|candidate| candidate.proof_type.clone())
        .or_else(|| {
            if request.start_cycle {
                super::repository_context::select_proof_type(&work_shape, &repository_context)
            } else {
                None
            }
        });
    let selected_proof_source = selected_candidate.map(|candidate| candidate.source.clone());
    let selected_proof_command = selected_candidate.map(|candidate| candidate.command.clone());
    let result = HarnessContextRouteResult {
        workspace: request.workspace.clone(),
        retrieve: decision.retrieve,
        route: decision.route.to_string(),
        search_query: query.to_string(),
        reason: decision.reason.to_string(),
        surfaces: decision
            .surfaces
            .iter()
            .map(|surface| (*surface).to_string())
            .collect(),
        work_shape: work_shape.clone(),
        work_scope: work_scope.clone(),
        selected_proof_type: selected_proof_type.clone(),
        selected_proof_source: selected_proof_source.clone(),
        selected_proof_command: selected_proof_command.clone(),
    };

    if request.start_cycle && request.run_id.is_none() {
        return Err(AppError::InvalidRequest(
            "starting a Harness closed-loop cycle requires run_id".into(),
        ));
    }

    if let Some(run_id) = request.run_id.as_deref() {
        let query_sha256 = hex::encode(Sha256::digest(query.as_bytes()));
        let mut tx = state.db.begin().await?;
        if request.start_cycle {
            let current: (i64, String) = sqlx::query_as(
                "SELECT verification_required, recovery_status FROM harness_run_loops WHERE run_id=?1",
            )
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await?;
            if current.0 != 0 || matches!(current.1.as_str(), "needed" | "in-progress") {
                return Err(AppError::InvalidRequest(
                    "Harness closed-loop cycle cannot restart while verification or recovery is unresolved".into(),
                ));
            }
            sqlx::query("DELETE FROM harness_run_proofs WHERE run_id=?1")
                .bind(run_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE harness_run_loops SET phase='context', context_reads=1, executions=0, \
                 verification_required=0, verification_status='idle', recovery_status='idle', \
                 failure_count=0, learning_count=0, last_failure_tool=NULL, last_failure_category=NULL, \
                 work_shape=?1, work_scope=?2, selected_proof_type=?3, selected_proof_source=?4, \
                 selected_proof_command=?5, updated_at=unixepoch() WHERE run_id=?6",
            )
            .bind(&work_shape)
            .bind(work_scope.as_deref())
            .bind(selected_proof_type.as_deref())
            .bind(selected_proof_source.as_deref())
            .bind(selected_proof_command.as_deref())
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            super::append_event_tx(
                &mut tx,
                run_id,
                "loop/cycle_started",
                &serde_json::json!({
                    "work_shape": work_shape,
                    "work_scope": work_scope,
                    "selected_proof_type": selected_proof_type,
                    "selected_proof_source": selected_proof_source,
                }),
            )
            .await?;
        }
        super::append_event_tx(
            &mut tx,
            run_id,
            "context/gate",
            &serde_json::json!({
                "retrieve": result.retrieve,
                "route": result.route,
                "surfaces": result.surfaces,
                "query_sha256": query_sha256,
                "query_bytes": query.len(),
                "cycle_start": request.start_cycle,
                "work_shape": result.work_shape,
                "work_scope": result.work_scope,
                "selected_proof_type": result.selected_proof_type,
            }),
        )
        .await?;
        tx.commit().await?;
    }

    Ok(result)
}

fn infer_work_scope(
    query: &str,
    context: &super::repository_context::HarnessRepositoryContext,
) -> Option<String> {
    let lower = query.to_ascii_lowercase();
    let explicit_alias = if contains_any(
        &lower,
        &[
            "desktop",
            "renderer",
            "electron",
            "desktop ui",
            "composer ui",
        ],
    ) {
        Some("desktop")
    } else if contains_any(&lower, &["frontend", "web ui", "web app"]) {
        Some("web")
    } else {
        None
    };

    let mut scopes = context
        .validation_owners
        .iter()
        .filter_map(|owner| {
            let parent = std::path::Path::new(owner).parent()?;
            let value = parent.to_string_lossy().replace('\\', "/");
            if value.is_empty() || value == "." {
                None
            } else {
                Some(value)
            }
        })
        .collect::<Vec<_>>();
    scopes.sort_by_key(|scope| std::cmp::Reverse(scope.len()));
    scopes.dedup();

    if let Some(alias) = explicit_alias
        && let Some(scope) = scopes.iter().find(|scope| {
            scope.as_str() == alias
                || scope.ends_with(&format!("/{alias}"))
                || (alias == "web" && scope.contains("/web"))
        })
    {
        return Some(scope.clone());
    }

    for scope in &scopes {
        let scope_lower = scope.to_ascii_lowercase();
        if lower.contains(&scope_lower) {
            return Some(scope.clone());
        }
        if let Some(last) = scope_lower.rsplit('/').next()
            && last.len() >= 3
            && lower
                .split(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '-' && character != '_'
                })
                .any(|token| token == last)
        {
            return Some(scope.clone());
        }
    }
    None
}

fn classify_work_shape(query: &str) -> &'static str {
    let lower = query.to_ascii_lowercase();
    if contains_any(
        &lower,
        &[
            "security",
            "auth",
            "oauth",
            "permission",
            "sandbox",
            "approval",
            "credential",
            "secret",
            "rbac",
            "policy",
            "authorization",
        ],
    ) {
        return "invariant";
    }
    if contains_any(
        &lower,
        &[
            "migration",
            "migrate",
            "schema",
            "database",
            "persistence",
            "restart-safe",
            "recovery",
            "release",
            "ci ",
            "workflow",
            "daemon",
            "upgrade",
        ],
    ) {
        return "durable";
    }
    if contains_any(
        &lower,
        &[
            "run app",
            "start app",
            "launch app",
            "dev server",
            "serve app",
            "preview app",
            "playwright",
            "e2e",
            "electron",
            "chạy app",
            "mở app",
        ],
    ) {
        return "operate-application";
    }
    if contains_any(
        &lower,
        &[
            "fix",
            "implement",
            "add ",
            "remove",
            "update",
            "change",
            "refactor",
            "rename",
            "create",
            "delete",
            "patch",
            "sửa",
            "thêm",
            "xóa",
            "cập nhật",
            "đổi",
            "triển khai",
            "chỉnh",
        ],
    ) {
        return "bounded";
    }
    "read-only"
}

fn classify(query: &str) -> Decision {
    let lower = query.to_ascii_lowercase();
    let normalized = lower.trim_matches(|character: char| {
        character.is_whitespace() || matches!(character, '.' | ',' | '!' | '?')
    });

    if matches!(
        normalized,
        "hi" | "hello" | "hey" | "thanks" | "thank you" | "ok" | "okay" | "got it"
    ) {
        return Decision {
            retrieve: false,
            route: "none",
            reason: "request is a self-contained acknowledgement",
            surfaces: &[],
        };
    }

    if looks_like_source_path(query) {
        return Decision {
            retrieve: true,
            route: "exact-source",
            reason: "query references a repository path",
            surfaces: &["read_file", "plugin_catalog", "mcp_extension_catalog"],
        };
    }

    if contains_any(
        &lower,
        &[
            "impact",
            "blast radius",
            "affected",
            "what breaks",
            "could break",
            "dependency impact",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "impact",
            reason: "query asks about transitive change impact; delegate repository intelligence to plugins/MCP",
            surfaces: &["git_diff", "plugin_catalog", "mcp_extension_catalog"],
        };
    }

    if contains_any(
        &lower,
        &[
            "architecture",
            "module boundary",
            "component",
            "cluster",
            "system flow",
            "structure",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "architecture",
            reason: "query asks for repository structure; delegate repository intelligence to plugins/MCP",
            surfaces: &["plugin_catalog", "mcp_extension_catalog"],
        };
    }

    if contains_any(
        &lower,
        &[
            "caller",
            "callee",
            "reference",
            "symbol",
            "function",
            "method",
            "class",
            "implementation",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "symbol-graph",
            reason: "query asks about code symbols or relationships; delegate repository intelligence to plugins/MCP",
            surfaces: &["plugin_catalog", "mcp_extension_catalog"],
        };
    }

    if contains_any(
        &lower,
        &[
            "git diff",
            "branch",
            "commit",
            "head sha",
            "git head",
            "changed files",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "git-state",
            reason: "query depends on current Git state",
            surfaces: &["repo_snapshot", "git_diff"],
        };
    }

    if contains_any(
        &lower,
        &[
            "semantic",
            "similar code",
            "concept",
            "conceptually",
            "related code",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "semantic",
            reason: "query benefits from conceptual retrieval; delegate repository intelligence to plugins/MCP",
            surfaces: &["plugin_catalog", "mcp_extension_catalog"],
        };
    }

    if contains_any(
        &lower,
        &[
            "where is",
            "where are",
            "find",
            "search",
            "defined",
            "definition",
            "locate",
        ],
    ) {
        return Decision {
            retrieve: true,
            route: "text-search",
            reason: "query asks to locate repository evidence; delegate repository intelligence to plugins/MCP",
            surfaces: &["plugin_catalog", "mcp_extension_catalog"],
        };
    }

    Decision {
        retrieve: true,
        route: "mixed",
        reason: "repository-bound request delegates intelligence to plugins/MCP",
        surfaces: &["plugin_catalog", "mcp_extension_catalog"],
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn looks_like_source_path(query: &str) -> bool {
    const EXTENSIONS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".sql", ".toml", ".yml", ".yaml",
        ".py", ".go", ".java", ".kt", ".prisma",
    ];
    query.split_whitespace().any(|token| {
        let token = token.trim_matches(|character: char| {
            matches!(
                character,
                '`' | '\'' | '"' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ':' | ';'
            )
        });
        (token.contains('/') || token.contains('\\'))
            && EXTENSIONS
                .iter()
                .any(|extension| token.to_ascii_lowercase().ends_with(extension))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_skips_only_obvious_acknowledgements() {
        let decision = classify("Thanks!");
        assert!(!decision.retrieve);
        assert_eq!(decision.route, "none");

        let decision = classify("Explain the current Harness policy");
        assert!(decision.retrieve);
        assert_eq!(decision.route, "mixed");
    }

    #[test]
    fn gate_prefers_specific_repository_surfaces() {
        assert_eq!(classify("read src/harness.rs").route, "exact-source");
        assert_eq!(
            classify("what is the blast radius of this change?").route,
            "impact"
        );
        assert_eq!(
            classify("show the architecture modules").route,
            "architecture"
        );
        assert_eq!(classify("find callers of begin").route, "symbol-graph");
        assert_eq!(classify("show the current git diff").route, "git-state");
        assert_eq!(classify("find conceptually similar code").route, "semantic");
        assert_eq!(classify("where is oauth defined?").route, "text-search");
    }

    #[test]
    fn work_shape_classification_separates_read_only_bounded_durable_and_invariant_work() {
        assert_eq!(classify_work_shape("explain this module"), "read-only");
        assert_eq!(classify_work_shape("fix the login button"), "bounded");
        assert_eq!(
            classify_work_shape("migrate the database schema"),
            "durable"
        );
        assert_eq!(
            classify_work_shape("fix OAuth permission policy"),
            "invariant"
        );
        assert_eq!(
            classify_work_shape("run app and inspect the UI"),
            "operate-application"
        );
        let context = crate::harness::repository_context::HarnessRepositoryContext {
            validation_owners: vec!["Cargo.toml".into(), "desktop/package.json".into()],
            ..Default::default()
        };
        assert_eq!(
            infer_work_scope("fix renderer UI", &context).as_deref(),
            Some("desktop")
        );
        assert_eq!(infer_work_scope("fix Rust daemon", &context), None);
    }
}
