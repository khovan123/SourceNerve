use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

const MAX_EXTENSIONS: usize = 128;
const MAX_POLICIES_PER_PLUGIN: usize = 128;
const MAX_PROVIDERS_PER_PLUGIN: usize = 64;
const MAX_OBSERVER_EVENTS: usize = 32;
const MAX_MCP_OWNERSHIP: usize = 512;
const MAX_OWNERS_PER_EXTENSION: usize = 32;
const MAX_OBSERVATIONS_PER_OBSERVER: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessRuntimeExtension {
    pub plugin_id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    pub config_hash: String,
    #[serde(default)]
    pub policy_interceptors: Vec<PluginHarnessPolicyInterceptor>,
    #[serde(default)]
    pub job_providers: Vec<PluginHarnessJobProvider>,
    #[serde(default)]
    pub sandbox_providers: Vec<PluginHarnessSandboxProvider>,
    #[serde(default)]
    pub context_providers: Vec<PluginHarnessContextProvider>,
    #[serde(default)]
    pub event_observers: Vec<PluginHarnessEventObserver>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessPolicyInterceptor {
    pub id: String,
    pub target: PluginHarnessPolicyTarget,
    pub decision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginHarnessPolicyTarget {
    Skill { skill_id: String },
    Mcp,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessJobProvider {
    pub id: String,
    pub runtime: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessSandboxProvider {
    pub id: String,
    pub modes: Vec<String>,
    pub enforcement: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessContextProvider {
    pub id: String,
    pub skill_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessEventObserver {
    pub id: String,
    pub events: Vec<String>,
    pub mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginHarnessMcpOwnership {
    pub extension_id: String,
    pub owners: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PluginHarnessObservation {
    pub event_type: String,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Default)]
struct RuntimeState {
    extensions: BTreeMap<String, PluginHarnessRuntimeExtension>,
    mcp_ownership: BTreeMap<String, Vec<String>>,
    observations: BTreeMap<(String, String), VecDeque<PluginHarnessObservation>>,
}

static STATE: OnceLock<RwLock<RuntimeState>> = OnceLock::new();

fn state() -> &'static RwLock<RuntimeState> {
    STATE.get_or_init(|| RwLock::new(RuntimeState::default()))
}

pub async fn replace(
    extensions: Vec<PluginHarnessRuntimeExtension>,
    ownership: Vec<PluginHarnessMcpOwnership>,
) -> Result<(), String> {
    let extensions = validate_extensions(extensions)?;
    let ownership = validate_ownership(ownership, extensions.keys().cloned().collect())?;
    let mut guard = state().write().await;
    let mut next_observations = BTreeMap::new();
    for extension in extensions.values() {
        for observer in &extension.event_observers {
            let key = (extension.plugin_id.clone(), observer.id.clone());
            if let Some(existing) = guard.observations.remove(&key) {
                next_observations.insert(key, existing);
            }
        }
    }
    guard.extensions = extensions;
    guard.mcp_ownership = ownership;
    guard.observations = next_observations;
    Ok(())
}

pub async fn snapshot_sha256() -> String {
    let guard = state().read().await;
    let value = serde_json::json!({
        "extensions": guard.extensions,
        "mcp_ownership": guard.mcp_ownership,
    });
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

pub async fn extensions() -> Vec<PluginHarnessRuntimeExtension> {
    state().read().await.extensions.values().cloned().collect()
}

pub async fn skill_policy(plugin_id: &str, skill_id: &str) -> Option<String> {
    let guard = state().read().await;
    let extension = guard.extensions.get(plugin_id)?;
    strictest_policy(
        extension
            .policy_interceptors
            .iter()
            .filter(|policy| {
                matches!(
                    &policy.target,
                    PluginHarnessPolicyTarget::Skill { skill_id: target } if target == skill_id
                )
            })
            .map(|policy| policy.decision.as_str()),
    )
    .map(str::to_string)
}

pub async fn mcp_owners(extension_id: &str) -> Vec<String> {
    state()
        .read()
        .await
        .mcp_ownership
        .get(extension_id)
        .cloned()
        .unwrap_or_default()
}

pub async fn mcp_policy(extension_id: &str) -> Option<String> {
    let guard = state().read().await;
    let owners = guard.mcp_ownership.get(extension_id)?;
    strictest_policy(owners.iter().flat_map(|owner| {
        guard
            .extensions
            .get(owner)
            .into_iter()
            .flat_map(|extension| extension.policy_interceptors.iter())
            .filter(|policy| matches!(policy.target, PluginHarnessPolicyTarget::Mcp))
            .map(|policy| policy.decision.as_str())
    }))
    .map(str::to_string)
}

pub async fn observe_harness_event(event_type: &str, payload: &serde_json::Value) {
    let plugin_ids = payload
        .get("plugin_ids")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    if plugin_ids.is_empty() {
        return;
    }
    let metadata = sanitize_event_metadata(payload);
    let mut guard = state().write().await;
    let deliveries = guard
        .extensions
        .values()
        .filter(|extension| plugin_ids.contains(extension.plugin_id.as_str()))
        .flat_map(|extension| {
            extension
                .event_observers
                .iter()
                .filter(move |observer| observer.events.iter().any(|event| event == event_type))
                .map(move |observer| (extension.plugin_id.clone(), observer.id.clone()))
        })
        .collect::<Vec<_>>();
    for key in deliveries {
        let queue = guard.observations.entry(key).or_default();
        if queue.len() >= MAX_OBSERVATIONS_PER_OBSERVER {
            queue.pop_front();
        }
        queue.push_back(PluginHarnessObservation {
            event_type: event_type.to_string(),
            metadata: metadata.clone(),
        });
    }
}

pub async fn observer_facts(plugin_id: &str, observer_id: &str) -> Vec<PluginHarnessObservation> {
    state()
        .read()
        .await
        .observations
        .get(&(plugin_id.to_string(), observer_id.to_string()))
        .map(|queue| queue.iter().cloned().collect())
        .unwrap_or_default()
}

fn validate_extensions(
    input: Vec<PluginHarnessRuntimeExtension>,
) -> Result<BTreeMap<String, PluginHarnessRuntimeExtension>, String> {
    if input.len() > MAX_EXTENSIONS {
        return Err(format!(
            "plugin Harness extension registry exceeds {MAX_EXTENSIONS} plugins"
        ));
    }
    let mut next = BTreeMap::new();
    for extension in input {
        validate_extension(&extension)?;
        if next.insert(extension.plugin_id.clone(), extension).is_some() {
            return Err("duplicate plugin Harness extension id".to_string());
        }
    }
    Ok(next)
}

fn validate_extension(extension: &PluginHarnessRuntimeExtension) -> Result<(), String> {
    valid_id(&extension.plugin_id, "plugin id")?;
    bounded_text(&extension.plugin_name, 128, "plugin name")?;
    bounded_text(&extension.plugin_version, 64, "plugin version")?;
    valid_sha256(&extension.config_hash, "Harness config hash")?;
    if extension.policy_interceptors.len() > MAX_POLICIES_PER_PLUGIN {
        return Err("plugin Harness policy interceptor limit exceeded".to_string());
    }
    if extension.job_providers.len() > MAX_PROVIDERS_PER_PLUGIN
        || extension.sandbox_providers.len() > MAX_PROVIDERS_PER_PLUGIN
        || extension.context_providers.len() > MAX_PROVIDERS_PER_PLUGIN
        || extension.event_observers.len() > MAX_PROVIDERS_PER_PLUGIN
    {
        return Err("plugin Harness provider limit exceeded".to_string());
    }

    let mut ids = BTreeSet::new();
    for policy in &extension.policy_interceptors {
        valid_id(&policy.id, "policy interceptor id")?;
        unique(&mut ids, &format!("policy:{}", policy.id))?;
        if !matches!(policy.decision.as_str(), "ask" | "deny") {
            return Err(
                "plugin Harness policy interceptors may only tighten to ask or deny".to_string(),
            );
        }
        if let PluginHarnessPolicyTarget::Skill { skill_id } = &policy.target {
            valid_id(skill_id, "policy skill id")?;
        }
    }
    for provider in &extension.job_providers {
        valid_id(&provider.id, "job provider id")?;
        unique(&mut ids, &format!("job:{}", provider.id))?;
        if provider.runtime != "harness-job" {
            return Err("plugin job provider must use the existing harness-job runtime".to_string());
        }
    }
    for provider in &extension.sandbox_providers {
        valid_id(&provider.id, "sandbox provider id")?;
        unique(&mut ids, &format!("sandbox:{}", provider.id))?;
        if provider.modes.is_empty() || provider.modes.len() > 2 {
            return Err("plugin sandbox provider modes are invalid".to_string());
        }
        let mut modes = BTreeSet::new();
        for mode in &provider.modes {
            if !matches!(mode.as_str(), "read-only" | "workspace-write") {
                return Err(
                    "third-party sandbox providers cannot register danger-full-access".to_string(),
                );
            }
            if !modes.insert(mode) {
                return Err("plugin sandbox provider contains duplicate modes".to_string());
            }
        }
        if !matches!(provider.enforcement.as_str(), "partial" | "unavailable") {
            return Err(
                "third-party sandbox providers cannot claim trusted full enforcement".to_string(),
            );
        }
    }
    for provider in &extension.context_providers {
        valid_id(&provider.id, "context provider id")?;
        valid_id(&provider.skill_id, "context provider skill id")?;
        unique(&mut ids, &format!("context:{}", provider.id))?;
    }
    for observer in &extension.event_observers {
        valid_id(&observer.id, "event observer id")?;
        unique(&mut ids, &format!("observer:{}", observer.id))?;
        if observer.mode != "sanitized-metadata" {
            return Err("plugin event observers may receive sanitized-metadata only".to_string());
        }
        if observer.events.is_empty() || observer.events.len() > MAX_OBSERVER_EVENTS {
            return Err("plugin event observer event list is invalid".to_string());
        }
        let mut events = BTreeSet::new();
        for event in &observer.events {
            if !safe_event_type(event) {
                return Err(format!("unsupported plugin Harness observer event `{event}`"));
            }
            if !events.insert(event) {
                return Err("plugin event observer contains duplicate events".to_string());
            }
        }
    }
    Ok(())
}

fn validate_ownership(
    input: Vec<PluginHarnessMcpOwnership>,
    installed_plugins: BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    if input.len() > MAX_MCP_OWNERSHIP {
        return Err("plugin Harness MCP ownership limit exceeded".to_string());
    }
    let mut next = BTreeMap::new();
    for record in input {
        valid_id(&record.extension_id, "MCP extension id")?;
        if record.owners.is_empty() || record.owners.len() > MAX_OWNERS_PER_EXTENSION {
            return Err("plugin Harness MCP ownership owners are invalid".to_string());
        }
        let mut owners = BTreeSet::new();
        for owner in record.owners {
            valid_id(&owner, "MCP owner plugin id")?;
            if !installed_plugins.contains(&owner) {
                return Err(format!(
                    "plugin Harness MCP ownership references disabled or missing plugin `{owner}`"
                ));
            }
            if !owners.insert(owner) {
                return Err("plugin Harness MCP ownership contains duplicate owners".to_string());
            }
        }
        if next
            .insert(record.extension_id, owners.into_iter().collect())
            .is_some()
        {
            return Err("duplicate plugin Harness MCP ownership extension".to_string());
        }
    }
    Ok(next)
}

fn strictest_policy<'a>(values: impl Iterator<Item = &'a str>) -> Option<&'static str> {
    let mut result = None;
    for value in values {
        match value {
            "deny" => return Some("deny"),
            "ask" => result = Some("ask"),
            _ => {}
        }
    }
    result
}

fn sanitize_event_metadata(payload: &serde_json::Value) -> BTreeMap<String, String> {
    const SAFE_KEYS: &[&str] = &[
        "execution_id",
        "tool",
        "capability_id",
        "result",
        "duration_ms",
        "error_category",
        "policy",
        "sandbox",
    ];
    let mut result = BTreeMap::new();
    let Some(object) = payload.as_object() else {
        return result;
    };
    for key in SAFE_KEYS {
        let Some(value) = object.get(*key) else {
            continue;
        };
        let encoded = match value {
            serde_json::Value::String(value) if value.len() <= 256 => value.clone(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::Bool(value) => value.to_string(),
            _ => continue,
        };
        result.insert((*key).to_string(), encoded);
    }
    result
}

fn safe_event_type(value: &str) -> bool {
    matches!(
        value,
        "tool/requested"
            | "tool/approved"
            | "tool/started"
            | "tool/result"
            | "tool/failed"
            | "job/started"
            | "job/completed"
            | "job/failed"
            | "approval/requested"
            | "approval/resolved"
            | "checkpoint/created"
            | "run/completed"
            | "run/cancelled"
            | "run/failed"
            | "run/stale"
    )
}

fn unique(values: &mut BTreeSet<String>, value: &str) -> Result<(), String> {
    if values.insert(value.to_string()) {
        Ok(())
    } else {
        Err(format!("duplicate plugin Harness registration `{value}`"))
    }
}

fn valid_id(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if !(1..=64).contains(&bytes.len())
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(format!("plugin Harness {label} is invalid"));
    }
    if value == "core" || value.starts_with("core.") {
        return Err(format!("plugin Harness {label} uses reserved core namespace"));
    }
    Ok(())
}

fn bounded_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || value.trim().is_empty()
        || value.chars().any(char::is_control)
    {
        return Err(format!("plugin Harness {label} is invalid"));
    }
    Ok(())
}

fn valid_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("plugin Harness {label} is invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
        TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await
    }

    fn extension(decision: &str) -> PluginHarnessRuntimeExtension {
        PluginHarnessRuntimeExtension {
            plugin_id: "jira".into(),
            plugin_name: "Jira".into(),
            plugin_version: "1.0.0".into(),
            config_hash: "a".repeat(64),
            policy_interceptors: vec![PluginHarnessPolicyInterceptor {
                id: "guard".into(),
                target: PluginHarnessPolicyTarget::Skill {
                    skill_id: "triage".into(),
                },
                decision: decision.into(),
            }],
            job_providers: vec![PluginHarnessJobProvider {
                id: "jobs".into(),
                runtime: "harness-job".into(),
            }],
            sandbox_providers: vec![PluginHarnessSandboxProvider {
                id: "sandbox".into(),
                modes: vec!["read-only".into()],
                enforcement: "partial".into(),
            }],
            context_providers: vec![PluginHarnessContextProvider {
                id: "context".into(),
                skill_id: "triage".into(),
            }],
            event_observers: vec![PluginHarnessEventObserver {
                id: "audit".into(),
                events: vec!["tool/result".into()],
                mode: "sanitized-metadata".into(),
            }],
        }
    }

    #[tokio::test]
    async fn registration_is_reversible_and_policy_only_tightens() {
        let _guard = test_lock().await;
        replace(vec![extension("ask")], vec![]).await.unwrap();
        assert_eq!(skill_policy("jira", "triage").await.as_deref(), Some("ask"));
        let digest = snapshot_sha256().await;
        assert_eq!(digest.len(), 64);

        replace(vec![], vec![]).await.unwrap();
        assert!(skill_policy("jira", "triage").await.is_none());
        assert_ne!(snapshot_sha256().await, digest);

        let error = replace(vec![extension("allow")], vec![])
            .await
            .expect_err("plugin policy must not downgrade central policy");
        assert!(error.contains("only tighten"));
        assert!(extensions().await.is_empty());
    }

    #[tokio::test]
    async fn observer_receives_only_sanitized_owned_plugin_facts() {
        let _guard = test_lock().await;
        replace(vec![extension("ask")], vec![]).await.unwrap();
        observe_harness_event(
            "tool/result",
            &serde_json::json!({
                "plugin_ids": ["jira"],
                "execution_id": "exec-1",
                "tool": "plugin_skill_read",
                "capability_id": "plugin.jira.skill.triage",
                "result": "success",
                "raw_arguments": "DO_NOT_STORE",
                "authorization": "Bearer secret",
            }),
        )
        .await;
        let facts = observer_facts("jira", "audit").await;
        assert_eq!(facts.len(), 1);
        let encoded = serde_json::to_string(&facts).unwrap();
        assert!(encoded.contains("exec-1"));
        assert!(!encoded.contains("DO_NOT_STORE"));
        assert!(!encoded.contains("Bearer secret"));
    }

    #[tokio::test]
    async fn third_party_sandbox_cannot_claim_full_or_danger_access() {
        let _guard = test_lock().await;
        let mut invalid = extension("deny");
        invalid.sandbox_providers[0].enforcement = "full".into();
        assert!(replace(vec![invalid], vec![]).await.is_err());

        let mut invalid = extension("deny");
        invalid.sandbox_providers[0].modes = vec!["danger-full-access".into()];
        assert!(replace(vec![invalid], vec![]).await.is_err());
    }
}
