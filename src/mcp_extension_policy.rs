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
}
