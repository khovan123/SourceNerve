use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Automatic,
    Ask,
    Blocked,
}

impl ApprovalMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Ask => "ask",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "ask" => Ok(Self::Ask),
            "blocked" => Ok(Self::Blocked),
            other => Err(AppError::InvalidRequest(format!(
                "unsupported MCP extension approval mode `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolClassification {
    pub read_only: Option<bool>,
    pub destructive: Option<bool>,
    pub idempotent: Option<bool>,
    pub open_world: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolPolicy {
    pub enabled: bool,
    pub approval: ApprovalMode,
    pub classification: ToolClassification,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            approval: ApprovalMode::Blocked,
            classification: ToolClassification::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    RequireApproval,
    Deny,
}

/// Resolve the effective SourceNerve classification for a downstream MCP tool.
///
/// Downstream MCP annotations remain advisory. SourceNerve independently recognizes a
/// deliberately small set of obvious read verbs and mutation verbs from the tool name.
/// Mutation signals always win, so names such as `get_or_create` or `search_and_delete`
/// never become read-only just because they start with a read verb or advertise a
/// `readOnlyHint`.
///
/// Unknown semantics stay conservative: an unrecognized downstream `readOnlyHint: true`
/// is not sufficient by itself to grant read-only treatment, while an explicit false hint
/// is retained as a write/conservative signal.
pub fn resolve_tool_classification(
    tool_name: &str,
    hint: ToolClassification,
) -> ToolClassification {
    let tokens = tool_name_tokens(tool_name);
    let mut resolved = hint;

    match infer_read_only(&tokens) {
        Some(true) => {
            resolved.read_only = Some(true);
            resolved.destructive = Some(false);
        }
        Some(false) => {
            resolved.read_only = Some(false);
            if is_destructive(&tokens) {
                resolved.destructive = Some(true);
            }
        }
        None => {
            // Third-party positive annotations are hints, not authorization authority.
            // Preserve an explicit false because it is already conservative; otherwise
            // leave the semantics unknown so the gateway routes through the write path.
            resolved.read_only = match hint.read_only {
                Some(false) => Some(false),
                _ => None,
            };
        }
    }

    resolved
}

fn infer_read_only(tokens: &[String]) -> Option<bool> {
    let first = tokens.first().map(String::as_str)?;
    let last = tokens.last().map(String::as_str)?;

    const MUTATION_WORDS: &[&str] = &[
        "add",
        "apply",
        "approve",
        "clear",
        "commit",
        "copy",
        "create",
        "delete",
        "deploy",
        "disable",
        "drop",
        "edit",
        "enable",
        "execute",
        "import",
        "ingest",
        "insert",
        "install",
        "manage",
        "merge",
        "move",
        "mutate",
        "patch",
        "publish",
        "push",
        "remove",
        "rename",
        "reset",
        "revoke",
        "save",
        "send",
        "set",
        "start",
        "stop",
        "store",
        "truncate",
        "uninstall",
        "update",
        "upload",
        "upsert",
        "write",
    ];

    if tokens
        .iter()
        .any(|token| MUTATION_WORDS.contains(&token.as_str()))
    {
        return Some(false);
    }

    // `index_repository` / `index_codebase` mutate a local derived index, while
    // `index_status` is an observation. Keep the distinction explicit.
    if matches!(first, "index" | "reindex") && last != "status" {
        return Some(false);
    }
    if matches!(first, "refresh" | "restart" | "run" | "sync") {
        return Some(false);
    }

    const READ_WORDS: &[&str] = &[
        "analyze",
        "analyse",
        "calculate",
        "check",
        "count",
        "describe",
        "detect",
        "diff",
        "explain",
        "fetch",
        "find",
        "get",
        "inspect",
        "list",
        "lookup",
        "preview",
        "query",
        "read",
        "resolve",
        "search",
        "show",
        "status",
        "summarize",
        "trace",
        "view",
    ];

    if READ_WORDS.contains(&first) || last == "status" {
        return Some(true);
    }

    None
}

fn is_destructive(tokens: &[String]) -> bool {
    const DESTRUCTIVE_WORDS: &[&str] = &[
        "clear",
        "delete",
        "drop",
        "remove",
        "reset",
        "truncate",
        "uninstall",
    ];
    tokens
        .iter()
        .any(|token| DESTRUCTIVE_WORDS.contains(&token.as_str()))
}

fn tool_name_tokens(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut previous_was_lower_or_digit = false;

    for ch in value.chars() {
        if !ch.is_ascii_alphanumeric() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
            previous_was_lower_or_digit = false;
            continue;
        }

        if ch.is_ascii_uppercase() && previous_was_lower_or_digit && !current.is_empty() {
            result.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
        previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }

    if !current.is_empty() {
        result.push(current);
    }
    result
}

pub fn evaluate_tool_policy(policy: Option<ToolPolicy>, user_approved: bool) -> PolicyDecision {
    let Some(policy) = policy else {
        return PolicyDecision::Deny;
    };
    if !policy.enabled {
        return PolicyDecision::Deny;
    }
    match policy.approval {
        ApprovalMode::Automatic => PolicyDecision::Allow,
        ApprovalMode::Ask if user_approved => PolicyDecision::Allow,
        ApprovalMode::Ask => PolicyDecision::RequireApproval,
        ApprovalMode::Blocked => PolicyDecision::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tools_fail_closed() {
        assert_eq!(evaluate_tool_policy(None, false), PolicyDecision::Deny);
    }

    #[test]
    fn discovered_tool_default_is_blocked_and_disabled() {
        let policy = ToolPolicy::default();
        assert!(!policy.enabled);
        assert_eq!(policy.approval, ApprovalMode::Blocked);
        assert_eq!(
            evaluate_tool_policy(Some(policy), true),
            PolicyDecision::Deny
        );
    }

    #[test]
    fn ask_requires_explicit_approval() {
        let policy = ToolPolicy {
            enabled: true,
            approval: ApprovalMode::Ask,
            classification: ToolClassification::default(),
        };
        assert_eq!(
            evaluate_tool_policy(Some(policy), false),
            PolicyDecision::RequireApproval
        );
        assert_eq!(
            evaluate_tool_policy(Some(policy), true),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn source_nerve_recognizes_obvious_read_only_extension_tools() {
        for name in [
            "get_file_outline",
            "get_project_summary",
            "search_code",
            "search_symbols",
            "check_index_coverage",
            "detect_changes",
            "get_architecture",
            "get_code_snippet",
            "get_graph_schema",
            "index_status",
            "list_projects",
            "query_graph",
            "search_graph",
            "trace_path",
        ] {
            let resolved = resolve_tool_classification(name, ToolClassification::default());
            assert_eq!(resolved.read_only, Some(true), "{name}");
            assert_eq!(resolved.destructive, Some(false), "{name}");
        }
    }

    #[test]
    fn mutation_signals_override_read_prefixes_and_downstream_hints() {
        for name in [
            "delete_project",
            "index_repository",
            "index_codebase",
            "ingest_traces",
            "manage_adr",
            "get_or_create",
            "search_and_delete",
        ] {
            let resolved = resolve_tool_classification(
                name,
                ToolClassification {
                    read_only: Some(true),
                    destructive: Some(false),
                    idempotent: None,
                    open_world: None,
                },
            );
            assert_eq!(resolved.read_only, Some(false), "{name}");
        }
        assert_eq!(
            resolve_tool_classification("delete_project", ToolClassification::default())
                .destructive,
            Some(true)
        );
    }

    #[test]
    fn unknown_positive_downstream_hint_is_not_authoritative() {
        let resolved = resolve_tool_classification(
            "mystery_operation",
            ToolClassification {
                read_only: Some(true),
                destructive: None,
                idempotent: None,
                open_world: None,
            },
        );
        assert_eq!(resolved.read_only, None);
    }
}