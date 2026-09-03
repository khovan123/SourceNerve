use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::service::AppState;

#[path = "plugin_harness_extension.rs"]
#[allow(dead_code)]
pub mod harness_extension;

use harness_extension::{PluginHarnessMcpOwnership, PluginHarnessRuntimeExtension};

const MAX_SKILLS: usize = 256;
const MAX_SKILL_BYTES: usize = 128 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_NAME: usize = 128;
const MAX_DESCRIPTION: usize = 512;
const MAX_PUBLISHER: usize = 256;
const MAX_SKILL_WORKSPACES: usize = 256;
const HARNESS_MARKER_SKILL_ID: &str = "harness-extension";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginRuntimeSkill {
    pub plugin_id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    pub skill_id: String,
    pub skill_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub content_hash: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MaterializeRequest {
    skills: Vec<PluginRuntimeSkill>,
    #[serde(default)]
    harness_extensions: Vec<PluginHarnessRuntimeExtension>,
    #[serde(default)]
    mcp_ownership: Vec<PluginHarnessMcpOwnership>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceCatalogRequest {
    workspace: String,
}

#[derive(Debug, Deserialize)]
struct SkillReadRequest {
    workspace: String,
    plugin_id: String,
    skill_id: String,
}

#[derive(Clone, Debug, Serialize)]
struct SkillCatalogEntry {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    content_hash: String,
    bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
struct PluginCatalogEntry {
    id: String,
    name: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    skills: Vec<SkillCatalogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    harness_config_hash: Option<String>,
}

type SkillKey = (String, String);
type SkillMap = BTreeMap<SkillKey, PluginRuntimeSkill>;

static SKILLS: OnceLock<RwLock<SkillMap>> = OnceLock::new();

fn skills() -> &'static RwLock<SkillMap> {
    SKILLS.get_or_init(|| RwLock::new(BTreeMap::new()))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plugin-hub/materialize", post(materialize_http))
        .route("/plugin-hub/catalog", get(catalog_http))
        .route("/plugin-hub/skill/read", post(read_skill_http))
}

#[allow(dead_code)]
pub async fn materialize(input: Vec<PluginRuntimeSkill>) -> Result<usize, String> {
    materialize_runtime(input, Vec::new(), Vec::new()).await
}

pub async fn materialize_runtime(
    mut input: Vec<PluginRuntimeSkill>,
    extensions: Vec<PluginHarnessRuntimeExtension>,
    ownership: Vec<PluginHarnessMcpOwnership>,
) -> Result<usize, String> {
    append_harness_markers(&mut input, &extensions)?;
    let next = validate_materialization(input)?;
    harness_extension::replace(extensions, ownership).await?;
    let count = next.len();
    *skills().write().await = next;
    Ok(count)
}

#[cfg(test)]
async fn catalog() -> serde_json::Value {
    serde_json::to_value(catalog_entries(None).await).unwrap_or_else(|_| serde_json::json!([]))
}

pub async fn catalog_for_workspace(workspace: &str) -> serde_json::Value {
    if !valid_id(workspace) {
        return serde_json::json!([]);
    }
    serde_json::to_value(catalog_entries(Some(workspace)).await)
        .unwrap_or_else(|_| serde_json::json!([]))
}

async fn read_skill(plugin_id: &str, skill_id: &str) -> Option<PluginRuntimeSkill> {
    if !valid_id(plugin_id) || !valid_id(skill_id) {
        return None;
    }
    skills()
        .read()
        .await
        .get(&(plugin_id.to_owned(), skill_id.to_owned()))
        .cloned()
}

pub async fn read_skill_for_workspace(
    workspace: &str,
    plugin_id: &str,
    skill_id: &str,
) -> Option<PluginRuntimeSkill> {
    if !valid_id(workspace) {
        return None;
    }
    let skill = read_skill(plugin_id, skill_id).await?;
    skill_available_in_workspace(&skill, workspace).then_some(skill)
}

async fn materialize_http(
    Json(request): Json<MaterializeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let count = materialize_runtime(
        request.skills,
        request.harness_extensions,
        request.mcp_ownership,
    )
    .await
    .map_err(|message| bad_request(&message))?;
    Ok(Json(serde_json::json!({
        "materialized": count,
        "status": "ok"
    })))
}

async fn catalog_http(
    State(state): State<AppState>,
    Query(request): Query<WorkspaceCatalogRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if !valid_id(&request.workspace) || state.workspaces.get(&request.workspace).is_err() {
        return Err(bad_request(
            "workspace must be a configured valid identifier",
        ));
    }
    Ok(Json(serde_json::json!({
        "workspace": request.workspace,
        "plugins": catalog_entries(Some(&request.workspace)).await
    })))
}

async fn read_skill_http(
    State(state): State<AppState>,
    Json(request): Json<SkillReadRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if !valid_id(&request.workspace) || state.workspaces.get(&request.workspace).is_err() {
        return Err(bad_request(
            "workspace must be a configured valid identifier",
        ));
    }
    if !valid_id(&request.plugin_id) || !valid_id(&request.skill_id) {
        return Err(bad_request(
            "plugin_id and skill_id must be valid identifiers",
        ));
    }
    let skill = read_skill_for_workspace(&request.workspace, &request.plugin_id, &request.skill_id)
        .await
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "plugin skill is not enabled for this workspace or installed"
                })),
            )
        })?;
    Ok(Json(serde_json::json!({
        "workspace": request.workspace,
        "skill": skill
    })))
}

async fn catalog_entries(workspace: Option<&str>) -> Vec<PluginCatalogEntry> {
    let extensions = harness_extension::extensions().await;
    let guard = skills().read().await;
    let mut grouped: BTreeMap<String, PluginCatalogEntry> = BTreeMap::new();
    for skill in guard.values() {
        if workspace.is_some_and(|workspace| !skill_available_in_workspace(skill, workspace)) {
            continue;
        }
        let plugin = grouped
            .entry(skill.plugin_id.clone())
            .or_insert_with(|| PluginCatalogEntry {
                id: skill.plugin_id.clone(),
                name: skill.plugin_name.clone(),
                version: skill.plugin_version.clone(),
                publisher: skill.publisher.clone(),
                skills: Vec::new(),
                harness_config_hash: None,
            });
        plugin.skills.push(SkillCatalogEntry {
            id: skill.skill_id.clone(),
            name: skill.skill_name.clone(),
            description: skill.description.clone(),
            content_hash: skill.content_hash.clone(),
            bytes: skill.content.len(),
        });
    }
    for extension in extensions {
        if workspace.is_some() && !grouped.contains_key(&extension.plugin_id) {
            continue;
        }
        let plugin = grouped
            .entry(extension.plugin_id.clone())
            .or_insert_with(|| PluginCatalogEntry {
                id: extension.plugin_id.clone(),
                name: extension.plugin_name.clone(),
                version: extension.plugin_version.clone(),
                publisher: None,
                skills: Vec::new(),
                harness_config_hash: None,
            });
        plugin.harness_config_hash = Some(extension.config_hash);
    }
    grouped.into_values().collect()
}

fn append_harness_markers(
    input: &mut Vec<PluginRuntimeSkill>,
    extensions: &[PluginHarnessRuntimeExtension],
) -> Result<(), String> {
    let existing = input
        .iter()
        .map(|skill| (skill.plugin_id.clone(), skill.skill_id.clone()))
        .collect::<BTreeSet<_>>();
    for extension in extensions {
        if existing.contains(&(
            extension.plugin_id.clone(),
            HARNESS_MARKER_SKILL_ID.to_string(),
        )) {
            return Err(format!(
                "plugin {} reserves skill id `{HARNESS_MARKER_SKILL_ID}` for Harness extension snapshot binding",
                extension.plugin_id
            ));
        }
        let workspace_ids = harness_marker_workspace_ids(input, &extension.plugin_id);
        let content = format!(
            "# Harness Extension\n\nSourceNerve declarative Harness extension metadata is active for plugin `{}`. Configuration fingerprint: `{}`. This marker contains no credentials and grants no authority.\n",
            extension.plugin_id, extension.config_hash
        );
        input.push(PluginRuntimeSkill {
            plugin_id: extension.plugin_id.clone(),
            plugin_name: extension.plugin_name.clone(),
            plugin_version: extension.plugin_version.clone(),
            publisher: None,
            skill_id: HARNESS_MARKER_SKILL_ID.to_string(),
            skill_name: "Harness Extension".to_string(),
            description: Some(
                "Declarative Harness extension snapshot marker; grants no authority.".to_string(),
            ),
            content_hash: format!("{:x}", Sha256::digest(content.as_bytes())),
            content,
            workspace_ids,
        });
    }
    Ok(())
}

fn harness_marker_workspace_ids(
    input: &[PluginRuntimeSkill],
    plugin_id: &str,
) -> Option<Vec<String>> {
    let mut found = false;
    let mut workspace_ids = BTreeSet::new();
    for skill in input.iter().filter(|skill| skill.plugin_id == plugin_id) {
        found = true;
        let scoped = skill.workspace_ids.as_ref()?;
        workspace_ids.extend(scoped.iter().cloned());
    }
    found.then(|| workspace_ids.into_iter().collect())
}

fn validate_materialization(input: Vec<PluginRuntimeSkill>) -> Result<SkillMap, String> {
    if input.len() > MAX_SKILLS {
        return Err(format!(
            "plugin skill materialization exceeds {MAX_SKILLS} skill limit"
        ));
    }
    let mut total = 0usize;
    let mut seen = BTreeSet::new();
    let mut next = BTreeMap::new();
    for skill in input {
        validate_skill(&skill)?;
        total = total
            .checked_add(skill.content.len())
            .ok_or_else(|| "plugin skill materialization size overflow".to_string())?;
        if total > MAX_TOTAL_BYTES {
            return Err("plugin skill materialization exceeds 8 MiB total limit".to_string());
        }
        let key = (skill.plugin_id.clone(), skill.skill_id.clone());
        if !seen.insert(key.clone()) {
            return Err(format!(
                "duplicate plugin skill {}/{}",
                skill.plugin_id, skill.skill_id
            ));
        }
        next.insert(key, skill);
    }
    Ok(next)
}

fn validate_skill(skill: &PluginRuntimeSkill) -> Result<(), String> {
    if !valid_id(&skill.plugin_id) || !valid_id(&skill.skill_id) {
        return Err(
            "plugin and skill ids must be 1-64 characters using A-Z, a-z, 0-9, ., _, or -"
                .to_string(),
        );
    }
    bounded_text(&skill.plugin_name, MAX_NAME, "plugin name")?;
    bounded_text(&skill.plugin_version, 64, "plugin version")?;
    bounded_text(&skill.skill_name, MAX_NAME, "skill name")?;
    if let Some(value) = skill.publisher.as_deref() {
        bounded_text(value, MAX_PUBLISHER, "plugin publisher")?;
    }
    if let Some(value) = skill.description.as_deref() {
        bounded_text(value, MAX_DESCRIPTION, "skill description")?;
    }
    if let Some(workspace_ids) = skill.workspace_ids.as_ref() {
        if workspace_ids.len() > MAX_SKILL_WORKSPACES {
            return Err(format!(
                "plugin skill {}/{} exceeds workspace scope limit",
                skill.plugin_id, skill.skill_id
            ));
        }
        let mut seen_workspaces = BTreeSet::new();
        for workspace in workspace_ids {
            if !valid_id(workspace) || !seen_workspaces.insert(workspace.as_str()) {
                return Err(format!(
                    "plugin skill {}/{} has invalid or duplicate workspace scope",
                    skill.plugin_id, skill.skill_id
                ));
            }
        }
    }
    if skill.content.len() > MAX_SKILL_BYTES {
        return Err(format!(
            "plugin skill {}/{} exceeds 128 KiB limit",
            skill.plugin_id, skill.skill_id
        ));
    }
    if skill.content.contains('\0') {
        return Err("plugin skill content contains NUL".to_string());
    }
    let calculated = format!("{:x}", Sha256::digest(skill.content.as_bytes()));
    if !valid_sha256(&skill.content_hash) || calculated != skill.content_hash {
        return Err(format!(
            "plugin skill {}/{} failed SHA-256 validation",
            skill.plugin_id, skill.skill_id
        ));
    }
    Ok(())
}

fn skill_available_in_workspace(skill: &PluginRuntimeSkill, workspace: &str) -> bool {
    skill
        .workspace_ids
        .as_ref()
        .is_none_or(|workspace_ids| workspace_ids.iter().any(|candidate| candidate == workspace))
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn bounded_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.chars().count() > max
        || value.trim().is_empty()
        || value.chars().any(char::is_control)
    {
        return Err(format!("plugin {label} is invalid"));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn bad_request(message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
        TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await
    }

    fn sample(content: &str) -> PluginRuntimeSkill {
        PluginRuntimeSkill {
            plugin_id: "jira".into(),
            plugin_name: "Jira".into(),
            plugin_version: "1.0.0".into(),
            publisher: Some("Example".into()),
            skill_id: "triage".into(),
            skill_name: "Triage issue".into(),
            description: Some("Triage one issue".into()),
            content_hash: format!("{:x}", Sha256::digest(content.as_bytes())),
            content: content.into(),
            workspace_ids: None,
        }
    }

    fn extension() -> PluginHarnessRuntimeExtension {
        PluginHarnessRuntimeExtension {
            plugin_id: "jira".into(),
            plugin_name: "Jira".into(),
            plugin_version: "1.0.0".into(),
            config_hash: "a".repeat(64),
            policy_interceptors: Vec::new(),
            job_providers: Vec::new(),
            sandbox_providers: Vec::new(),
            context_providers: Vec::new(),
            event_observers: Vec::new(),
        }
    }

    #[tokio::test]
    async fn materialization_catalogs_metadata_and_reads_exact_skill() {
        let _guard = test_lock().await;
        materialize(vec![sample("# Triage\nUse the issue fields.")])
            .await
            .unwrap();
        let value = catalog().await;
        assert_eq!(value[0]["id"], "jira");
        assert_eq!(value[0]["skills"][0]["id"], "triage");
        assert!(!value.to_string().contains("Use the issue fields"));

        let skill = read_skill("jira", "triage").await.unwrap();
        assert_eq!(skill.content, "# Triage\nUse the issue fields.");
        assert!(read_skill("jira", "missing").await.is_none());
    }

    #[tokio::test]
    async fn workspace_scoped_skills_do_not_leak_across_catalog_or_read_boundaries() {
        let _guard = test_lock().await;
        let mut scoped = sample("# Triage\nUse workspace-local issue fields.");
        scoped.workspace_ids = Some(vec!["workspace-a".into()]);
        materialize(vec![scoped]).await.unwrap();

        let workspace_a = catalog_for_workspace("workspace-a").await;
        let workspace_b = catalog_for_workspace("workspace-b").await;
        assert_eq!(workspace_a[0]["id"], "jira");
        assert_eq!(workspace_a[0]["skills"][0]["id"], "triage");
        assert_eq!(workspace_b, serde_json::json!([]));
        assert!(
            read_skill_for_workspace("workspace-a", "jira", "triage")
                .await
                .is_some()
        );
        assert!(
            read_skill_for_workspace("workspace-b", "jira", "triage")
                .await
                .is_none()
        );

        let global = catalog().await;
        assert_eq!(global[0]["id"], "jira");
    }

    #[tokio::test]
    async fn materialization_rejects_hash_mismatch_without_replacing_current_state() {
        let _guard = test_lock().await;
        materialize(vec![sample("good")]).await.unwrap();
        let mut invalid = sample("changed");
        invalid.content_hash = "0".repeat(64);
        assert!(materialize(vec![invalid]).await.is_err());
        assert_eq!(read_skill("jira", "triage").await.unwrap().content, "good");
    }

    #[tokio::test]
    async fn materialization_accepts_unicode_metadata_at_character_limit() {
        let _guard = test_lock().await;
        let mut skill = sample("good");
        skill.description = Some(format!("{}—", "a".repeat(MAX_DESCRIPTION - 1)));
        assert_eq!(
            skill.description.as_deref().unwrap().chars().count(),
            MAX_DESCRIPTION
        );
        assert!(skill.description.as_deref().unwrap().len() > MAX_DESCRIPTION);

        materialize(vec![skill]).await.unwrap();
        assert_eq!(
            catalog().await[0]["skills"][0]["description"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_DESCRIPTION
        );
    }

    #[tokio::test]
    async fn harness_extension_marker_binds_runtime_config_into_skill_snapshot() {
        let _guard = test_lock().await;
        materialize_runtime(vec![sample("good")], vec![extension()], vec![])
            .await
            .unwrap();
        let marker = read_skill("jira", HARNESS_MARKER_SKILL_ID)
            .await
            .expect("marker skill");
        assert!(marker.content.contains(&"a".repeat(64)));
        let catalog = catalog().await;
        assert_eq!(catalog[0]["harness_config_hash"], "a".repeat(64));
    }

    #[tokio::test]
    async fn harness_extension_marker_inherits_plugin_workspace_scope() {
        let _guard = test_lock().await;
        let mut scoped = sample("good");
        scoped.workspace_ids = Some(vec!["workspace-a".into()]);
        materialize_runtime(vec![scoped], vec![extension()], vec![])
            .await
            .unwrap();

        assert!(
            read_skill_for_workspace("workspace-a", "jira", HARNESS_MARKER_SKILL_ID)
                .await
                .is_some()
        );
        assert!(
            read_skill_for_workspace("workspace-b", "jira", HARNESS_MARKER_SKILL_ID)
                .await
                .is_none()
        );
        assert_eq!(
            catalog_for_workspace("workspace-b").await,
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn harness_extension_collision_fails_closed_without_replacing_runtime() {
        let _guard = test_lock().await;
        materialize_runtime(vec![sample("good")], vec![extension()], vec![])
            .await
            .unwrap();
        let before = read_skill("jira", HARNESS_MARKER_SKILL_ID)
            .await
            .expect("existing marker");

        let mut invalid = extension();
        invalid.plugin_id = "core.override".into();
        let error = materialize_runtime(Vec::new(), vec![invalid], Vec::new())
            .await
            .expect_err("reserved core namespace must fail closed");

        assert!(error.contains("reserved core namespace"));
        let after = read_skill("jira", HARNESS_MARKER_SKILL_ID)
            .await
            .expect("existing runtime remains materialized");
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(harness_extension::extensions().await[0].plugin_id, "jira");
    }
}
