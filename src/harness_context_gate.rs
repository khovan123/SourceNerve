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
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessContextRouteResult {
    pub workspace: String,
    pub retrieve: bool,
    pub route: String,
    pub search_query: String,
    pub reason: String,
    pub surfaces: Vec<String>,
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
    state.workspaces.get(&request.workspace)?;
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
    };

    if let Some(run_id) = request.run_id.as_deref() {
        let query_sha256 = hex::encode(Sha256::digest(query.as_bytes()));
        let mut tx = state.db.begin().await?;
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
            }),
        )
        .await?;
        tx.commit().await?;
    }

    Ok(result)
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
}
