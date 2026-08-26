use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    plugin_hub_runtime, runtime,
    service::AppState,
};

pub const DEFAULT_PROFILE: &str = "interactive-local";
pub const PROFILE_NAMES: &[&str] = &[
    "read-only-analysis",
    "interactive-local",
    "guarded-durable",
    "background-job",
    "webhook-automation",
];

const REGISTRY_VERSION: u32 = 1;
const MAX_CAPABILITIES: usize = 4096;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessCapabilitiesRequest {
    pub workspace: String,
    #[serde(default = "default_profile")]
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessProfileView {
    pub name: String,
    pub description: String,
    pub sandbox: String,
    pub policies: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessCapabilityView {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub kind: String,
    pub origin: String,
    pub origin_id: String,
    pub version: Option<String>,
    pub class: String,
    pub approval: String,
    pub available: bool,
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
    pub open_world: bool,
    pub security_critical: bool,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessCapabilitySnapshot {
    pub registry_version: u32,
    pub profile: HarnessProfileView,
    pub workspace_writable: bool,
    pub requires_runtime_authorization: bool,
    pub runtime_features: Vec<String>,
    pub capabilities: Vec<HarnessCapabilityView>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessCapabilitiesResult {
    pub workspace: String,
    pub snapshot: HarnessCapabilitySnapshot,
    pub snapshot_sha256: String,
    pub profiles: Vec<HarnessProfileView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    Allow,
    Ask,
    Deny,
}

impl Policy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }

    fn stricter(self, other: Self) -> Self {
        use Policy::{Allow, Ask, Deny};
        match (self, other) {
            (Deny, _) | (_, Deny) => Deny,
            (Ask, _) | (_, Ask) => Ask,
            (Allow, Allow) => Allow,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapabilityClass {
    Kernel,
    Read,
    Write,
    Exec,
    Git,
    Provider,
    Job,
}

impl CapabilityClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Kernel => "kernel",
            Self::Read => "read",
            Self::Write => "write",
            Self::Exec => "exec",
            Self::Git => "git",
            Self::Provider => "provider",
            Self::Job => "job",
        }
    }

    fn requires_writable_workspace(self) -> bool {
        !matches!(self, Self::Kernel | Self::Read)
    }
}

#[derive(Debug, Clone, Copy)]
struct ProfileSpec {
    name: &'static str,
    description: &'static str,
    sandbox: &'static str,
    read: Policy,
    write: Policy,
    exec: Policy,
    git: Policy,
    provider: Policy,
    job: Policy,
}

impl ProfileSpec {
    fn policy_for(self, class: CapabilityClass) -> Policy {
        match class {
            CapabilityClass::Kernel => Policy::Allow,
            CapabilityClass::Read => self.read,
            CapabilityClass::Write => self.write,
            CapabilityClass::Exec => self.exec,
            CapabilityClass::Git => self.git,
            CapabilityClass::Provider => self.provider,
            CapabilityClass::Job => self.job,
        }
    }

    fn view(self) -> HarnessProfileView {
        HarnessProfileView {
            name: self.name.to_string(),
            description: self.description.to_string(),
            sandbox: self.sandbox.to_string(),
            policies: BTreeMap::from([
                ("read".to_string(), self.read.as_str().to_string()),
                ("write".to_string(), self.write.as_str().to_string()),
                ("exec".to_string(), self.exec.as_str().to_string()),
                ("git".to_string(), self.git.as_str().to_string()),
                ("provider".to_string(), self.provider.as_str().to_string()),
                ("job".to_string(), self.job.as_str().to_string()),
            ]),
        }
    }
}

#[derive(Debug, Clone)]
struct CapabilityDraft {
    id: String,
    namespace: String,
    name: String,
    kind: String,
    origin: String,
    origin_id: String,
    version: Option<String>,
    class: CapabilityClass,
    source_policy: Policy,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
    security_critical: bool,
    fingerprint: Option<String>,
}

#[derive(Default)]
struct Registry {
    entries: BTreeMap<String, CapabilityDraft>,
}

impl Registry {
    fn register(&mut self, capability: CapabilityDraft) -> AppResult<()> {
        validate_capability_id(&capability.id)?;
        if capability.origin != "core" && capability.id.starts_with("core.") {
            return Err(AppError::InvalidRequest(format!(
                "third-party harness capability cannot register reserved core namespace: {}",
                capability.id
            )));
        }
        if capability.security_critical && capability.origin != "core" {
            return Err(AppError::InvalidRequest(format!(
                "third-party harness capability cannot replace security-critical capability: {}",
                capability.id
            )));
        }
        if self.entries.len() >= MAX_CAPABILITIES {
            return Err(AppError::InvalidRequest(format!(
                "harness capability registry exceeds {MAX_CAPABILITIES} entries"
            )));
        }
        if self.entries.contains_key(&capability.id) {
            return Err(AppError::InvalidRequest(format!(
                "harness capability namespace collision: {}",
                capability.id
            )));
        }
        self.entries.insert(capability.id.clone(), capability);
        Ok(())
    }

    fn resolve(self, profile: ProfileSpec, workspace_writable: bool) -> Vec<HarnessCapabilityView> {
        self.entries
            .into_values()
            .map(|capability| {
                let mut approval = profile
                    .policy_for(capability.class)
                    .stricter(capability.source_policy);
                if capability.class.requires_writable_workspace() && !workspace_writable {
                    approval = Policy::Deny;
                }
                HarnessCapabilityView {
                    id: capability.id,
                    namespace: capability.namespace,
                    name: capability.name,
                    kind: capability.kind,
                    origin: capability.origin,
                    origin_id: capability.origin_id,
                    version: capability.version,
                    class: capability.class.as_str().to_string(),
                    approval: approval.as_str().to_string(),
                    available: approval != Policy::Deny,
                    read_only: capability.read_only,
                    destructive: capability.destructive,
                    idempotent: capability.idempotent,
                    open_world: capability.open_world,
                    security_critical: capability.security_critical,
                    fingerprint: capability.fingerprint,
                }
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct PluginCatalogEntry {
    id: String,
    name: String,
    version: String,
    skills: Vec<PluginSkillEntry>,
}

#[derive(Debug, Deserialize)]
struct PluginSkillEntry {
    id: String,
    name: String,
    content_hash: String,
}

type ExtensionToolRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    String,
);

#[derive(Debug, Clone, Copy)]
struct CoreCapability {
    id: &'static str,
    namespace: &'static str,
    name: &'static str,
    kind: &'static str,
    class: CapabilityClass,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
    security_critical: bool,
}

macro_rules! core_capability {
    ($id:literal, $namespace:literal, $name:literal, $kind:literal, $class:expr, $read_only:expr, $destructive:expr, $idempotent:expr, $open_world:expr, $security_critical:expr) => {
        CoreCapability {
            id: $id,
            namespace: $namespace,
            name: $name,
            kind: $kind,
            class: $class,
            read_only: $read_only,
            destructive: $destructive,
            idempotent: $idempotent,
            open_world: $open_world,
            security_critical: $security_critical,
        }
    };
}

const CORE_CAPABILITIES: &[CoreCapability] = &[
    core_capability!(
        "core.security.authorization",
        "core.security",
        "Authorization kernel",
        "security-kernel",
        CapabilityClass::Kernel,
        true,
        false,
        true,
        false,
        true
    ),
    core_capability!(
        "core.security.workspace-boundary",
        "core.security",
        "Workspace boundary kernel",
        "security-kernel",
        CapabilityClass::Kernel,
        true,
        false,
        true,
        false,
        true
    ),
    core_capability!(
        "core.security.audit",
        "core.security",
        "Mandatory audit kernel",
        "security-kernel",
        CapabilityClass::Kernel,
        true,
        false,
        true,
        false,
        true
    ),
    core_capability!(
        "core.security.secret-isolation",
        "core.security",
        "Secret isolation kernel",
        "security-kernel",
        CapabilityClass::Kernel,
        true,
        false,
        true,
        false,
        true
    ),
    core_capability!(
        "core.repository.read",
        "core.repository",
        "Repository intelligence",
        "repository",
        CapabilityClass::Read,
        true,
        false,
        true,
        false,
        false
    ),
    core_capability!(
        "core.files.read",
        "core.files",
        "Workspace file read",
        "files",
        CapabilityClass::Read,
        true,
        false,
        true,
        false,
        false
    ),
    core_capability!(
        "core.files.write",
        "core.files",
        "Workspace file mutation",
        "files",
        CapabilityClass::Write,
        false,
        true,
        false,
        false,
        true
    ),
    core_capability!(
        "core.workspace.exec",
        "core.workspace",
        "Workspace process execution",
        "process",
        CapabilityClass::Exec,
        false,
        true,
        false,
        true,
        true
    ),
    core_capability!(
        "core.task.read",
        "core.task",
        "Durable task inspection",
        "task",
        CapabilityClass::Read,
        true,
        false,
        true,
        false,
        false
    ),
    core_capability!(
        "core.task.mutate",
        "core.task",
        "Durable guarded task mutation",
        "task",
        CapabilityClass::Write,
        false,
        true,
        false,
        false,
        true
    ),
    core_capability!(
        "core.git.read",
        "core.git",
        "Git inspection",
        "git",
        CapabilityClass::Read,
        true,
        false,
        true,
        false,
        false
    ),
    core_capability!(
        "core.git.mutate",
        "core.git",
        "Protected Git mutation",
        "git",
        CapabilityClass::Git,
        false,
        true,
        false,
        true,
        true
    ),
    core_capability!(
        "core.provider.read",
        "core.provider",
        "Provider inspection",
        "provider",
        CapabilityClass::Read,
        true,
        false,
        true,
        true,
        false
    ),
    core_capability!(
        "core.provider.mutate",
        "core.provider",
        "Protected provider mutation",
        "provider",
        CapabilityClass::Provider,
        false,
        true,
        false,
        true,
        true
    ),
    core_capability!(
        "core.jobs",
        "core.jobs",
        "Durable jobs",
        "job",
        CapabilityClass::Job,
        false,
        false,
        false,
        false,
        true
    ),
    core_capability!(
        "core.context.read",
        "core.context",
        "Context assembly",
        "context",
        CapabilityClass::Read,
        true,
        false,
        true,
        false,
        false
    ),
    core_capability!(
        "core.harness.run",
        "core.harness",
        "Harness run kernel",
        "harness",
        CapabilityClass::Kernel,
        false,
        false,
        true,
        false,
        true
    ),
];

fn default_profile() -> String {
    DEFAULT_PROFILE.to_string()
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn validate_capability_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 256
        || !value.is_ascii()
        || value.chars().any(char::is_control)
        || value.starts_with('.')
        || value.ends_with('.')
    {
        return Err(AppError::InvalidRequest(
            "harness capability id must be 1-256 printable ASCII characters".into(),
        ));
    }
    Ok(())
}

fn profile_spec(name: &str) -> AppResult<ProfileSpec> {
    let profile = match name {
        "read-only-analysis" => ProfileSpec {
            name: "read-only-analysis",
            description: "Repository, file, context, plugin skill, and classified read-only extension analysis only.",
            sandbox: "read-only",
            read: Policy::Allow,
            write: Policy::Deny,
            exec: Policy::Deny,
            git: Policy::Deny,
            provider: Policy::Deny,
            job: Policy::Deny,
        },
        "interactive-local" => ProfileSpec {
            name: "interactive-local",
            description: "Interactive local work with workspace writes and execution; protected Git/provider mutations require approval.",
            sandbox: "workspace-write",
            read: Policy::Allow,
            write: Policy::Allow,
            exec: Policy::Allow,
            git: Policy::Ask,
            provider: Policy::Ask,
            job: Policy::Allow,
        },
        "guarded-durable" => ProfileSpec {
            name: "guarded-durable",
            description: "Durable guarded mutation profile; shell, Git, and provider side effects require approval while protected task guards remain mandatory.",
            sandbox: "workspace-write",
            read: Policy::Allow,
            write: Policy::Allow,
            exec: Policy::Ask,
            git: Policy::Ask,
            provider: Policy::Ask,
            job: Policy::Allow,
        },
        "background-job" => ProfileSpec {
            name: "background-job",
            description: "Non-interactive background profile limited to reads and the durable job runtime; direct writes, exec, Git, and provider mutations are denied.",
            sandbox: "read-only",
            read: Policy::Allow,
            write: Policy::Deny,
            exec: Policy::Deny,
            git: Policy::Deny,
            provider: Policy::Deny,
            job: Policy::Allow,
        },
        "webhook-automation" => ProfileSpec {
            name: "webhook-automation",
            description: "Webhook-triggered profile limited to reads and durable jobs; interactive or open-ended mutation surfaces are denied.",
            sandbox: "read-only",
            read: Policy::Allow,
            write: Policy::Deny,
            exec: Policy::Deny,
            git: Policy::Deny,
            provider: Policy::Deny,
            job: Policy::Allow,
        },
        _ => {
            return Err(AppError::InvalidRequest(format!(
                "unsupported harness profile `{name}`"
            )));
        }
    };
    Ok(profile)
}

pub fn validate_profile(name: &str) -> AppResult<()> {
    profile_spec(name).map(|_| ())
}

pub fn profiles() -> Vec<HarnessProfileView> {
    PROFILE_NAMES
        .iter()
        .filter_map(|name| profile_spec(name).ok())
        .map(ProfileSpec::view)
        .collect()
}

fn register_core(registry: &mut Registry) -> AppResult<()> {
    for capability in CORE_CAPABILITIES {
        registry.register(CapabilityDraft {
            id: capability.id.to_string(),
            namespace: capability.namespace.to_string(),
            name: capability.name.to_string(),
            kind: capability.kind.to_string(),
            origin: "core".to_string(),
            origin_id: "sourcenerve".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            class: capability.class,
            source_policy: Policy::Allow,
            read_only: capability.read_only,
            destructive: capability.destructive,
            idempotent: capability.idempotent,
            open_world: capability.open_world,
            security_critical: capability.security_critical,
            fingerprint: None,
        })?;
    }
    Ok(())
}

async fn register_plugins(registry: &mut Registry) -> AppResult<()> {
    let catalog = plugin_hub_runtime::catalog().await;
    let plugins: Vec<PluginCatalogEntry> =
        serde_json::from_value(catalog).map_err(anyhow::Error::from)?;
    for plugin in plugins {
        if plugin.name.is_empty() {
            return Err(AppError::InvalidRequest(format!(
                "plugin {} has invalid empty name",
                plugin.id
            )));
        }
        for skill in plugin.skills {
            registry.register(CapabilityDraft {
                id: format!("plugin.{}.skill.{}", plugin.id, skill.id),
                namespace: format!("plugin.{}", plugin.id),
                name: skill.name,
                kind: "plugin-skill".to_string(),
                origin: "plugin".to_string(),
                origin_id: plugin.id.clone(),
                version: Some(plugin.version.clone()),
                class: CapabilityClass::Read,
                source_policy: Policy::Allow,
                read_only: true,
                destructive: false,
                idempotent: true,
                open_world: false,
                security_critical: false,
                fingerprint: Some(skill.content_hash),
            })?;
        }
    }
    Ok(())
}

fn flag(value: Option<i64>) -> Option<bool> {
    value.map(|value| value != 0)
}

async fn register_extensions(state: &AppState, registry: &mut Registry) -> AppResult<()> {
    let rows: Vec<ExtensionToolRow> = sqlx::query_as(
        "SELECT e.id, e.namespace, e.version, t.original_name, t.public_name, t.schema_hash, \
                t.read_only, t.destructive, t.idempotent, t.open_world, t.approval_mode \
         FROM mcp_extensions e \
         JOIN mcp_extension_tools t ON t.extension_id=e.id \
         WHERE e.enabled=1 AND e.status='enabled' AND t.enabled=1 \
         ORDER BY e.namespace, t.public_name",
    )
    .fetch_all(&state.db)
    .await?;

    for row in rows {
        let read_only = flag(row.6);
        let destructive = flag(row.7);
        let idempotent = flag(row.8);
        let open_world = flag(row.9);
        let classified = read_only.is_some()
            && destructive.is_some()
            && idempotent.is_some()
            && open_world.is_some();
        let class = if read_only == Some(true) && destructive == Some(false) {
            CapabilityClass::Read
        } else {
            CapabilityClass::Provider
        };
        let source_policy = if !classified {
            Policy::Deny
        } else {
            match row.10.as_str() {
                "automatic" => Policy::Allow,
                "ask" => Policy::Ask,
                "blocked" => Policy::Deny,
                _ => Policy::Deny,
            }
        };
        let public_digest = sha256(row.4.as_bytes());
        registry.register(CapabilityDraft {
            id: format!("mcp.{}.tool.{public_digest}", row.1),
            namespace: format!("mcp.{}", row.1),
            name: row.4,
            kind: "mcp-tool".to_string(),
            origin: "mcp-extension".to_string(),
            origin_id: row.0,
            version: Some(row.2),
            class,
            source_policy,
            read_only: read_only.unwrap_or(false),
            destructive: destructive.unwrap_or(true),
            idempotent: idempotent.unwrap_or(false),
            open_world: open_world.unwrap_or(true),
            security_critical: false,
            fingerprint: Some(format!("{}:{}", row.5, sha256(row.3.as_bytes()))),
        })?;
    }
    Ok(())
}

async fn build_snapshot(
    state: &AppState,
    workspace: &str,
    profile: &str,
) -> AppResult<HarnessCapabilitySnapshot> {
    let profile = profile_spec(profile)?;
    let workspace_config = state.workspaces.get(workspace)?;
    let mut registry = Registry::default();
    register_core(&mut registry)?;
    register_plugins(&mut registry).await?;
    register_extensions(state, &mut registry).await?;

    let mut runtime_features = runtime::identity()
        .capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    runtime_features.sort();

    Ok(HarnessCapabilitySnapshot {
        registry_version: REGISTRY_VERSION,
        profile: profile.view(),
        workspace_writable: workspace_config.writable,
        requires_runtime_authorization: true,
        runtime_features,
        capabilities: registry.resolve(profile, workspace_config.writable),
    })
}

pub async fn snapshot(
    state: &AppState,
    workspace: &str,
    profile: &str,
) -> AppResult<(String, String)> {
    let snapshot = build_snapshot(state, workspace, profile).await?;
    let encoded = serde_json::to_string(&snapshot).map_err(anyhow::Error::from)?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "harness capability snapshot exceeds {MAX_SNAPSHOT_BYTES} bytes"
        )));
    }
    let digest = sha256(encoded.as_bytes());
    Ok((encoded, digest))
}

pub async fn resolve(
    state: &AppState,
    request: HarnessCapabilitiesRequest,
) -> AppResult<HarnessCapabilitiesResult> {
    let snapshot = build_snapshot(state, &request.workspace, &request.profile).await?;
    let encoded = serde_json::to_string(&snapshot).map_err(anyhow::Error::from)?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "harness capability snapshot exceeds {MAX_SNAPSHOT_BYTES} bytes"
        )));
    }
    Ok(HarnessCapabilitiesResult {
        workspace: request.workspace,
        snapshot_sha256: sha256(encoded.as_bytes()),
        snapshot,
        profiles: profiles(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(id: &str, origin: &str, critical: bool) -> CapabilityDraft {
        CapabilityDraft {
            id: id.to_string(),
            namespace: id
                .rsplit_once('.')
                .map(|value| value.0)
                .unwrap_or(id)
                .to_string(),
            name: id.to_string(),
            kind: "test".to_string(),
            origin: origin.to_string(),
            origin_id: origin.to_string(),
            version: None,
            class: CapabilityClass::Read,
            source_policy: Policy::Allow,
            read_only: true,
            destructive: false,
            idempotent: true,
            open_world: false,
            security_critical: critical,
            fingerprint: None,
        }
    }

    #[test]
    fn profile_names_and_security_kernel_are_stable() {
        let expected = PROFILE_NAMES
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            profiles()
                .into_iter()
                .map(|profile| profile.name)
                .collect::<Vec<_>>(),
            expected
        );
        for name in PROFILE_NAMES {
            let profile = profile_spec(name).expect("known profile");
            assert_eq!(profile.policy_for(CapabilityClass::Kernel), Policy::Allow);
        }
        assert!(validate_profile("unknown").is_err());
    }

    #[test]
    fn namespace_collisions_and_core_replacement_fail_closed() {
        let mut registry = Registry::default();
        registry
            .register(draft("plugin.alpha.skill.read", "plugin", false))
            .unwrap();
        assert!(
            registry
                .register(draft("plugin.alpha.skill.read", "plugin", false))
                .is_err()
        );

        let mut registry = Registry::default();
        assert!(
            registry
                .register(draft("core.security.authorization", "plugin", false))
                .is_err()
        );
        assert!(
            registry
                .register(draft("plugin.bad.security", "plugin", true))
                .is_err()
        );
    }

    #[test]
    fn profile_policy_never_weakens_extension_policy() {
        let interactive = profile_spec("interactive-local").unwrap();
        assert_eq!(
            interactive
                .policy_for(CapabilityClass::Provider)
                .stricter(Policy::Allow),
            Policy::Ask
        );
        assert_eq!(
            interactive
                .policy_for(CapabilityClass::Read)
                .stricter(Policy::Ask),
            Policy::Ask
        );
        assert_eq!(
            interactive
                .policy_for(CapabilityClass::Read)
                .stricter(Policy::Deny),
            Policy::Deny
        );
    }
}
