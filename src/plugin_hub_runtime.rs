use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::service::AppState;

const MAX_SKILLS: usize = 256;
const MAX_SKILL_BYTES: usize = 128 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_NAME: usize = 128;
const MAX_DESCRIPTION: usize = 512;
const MAX_PUBLISHER: usize = 256;

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
}

#[derive(Debug, Deserialize)]
struct MaterializeRequest {
    skills: Vec<PluginRuntimeSkill>,
}

#[derive(Debug, Deserialize)]
struct SkillReadRequest {
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

pub async fn materialize(input: Vec<PluginRuntimeSkill>) -> Result<usize, String> {
    let next = validate_materialization(input)?;
    let count = next.len();
    *skills().write().await = next;
    Ok(count)
}

pub async fn catalog() -> serde_json::Value {
    serde_json::to_value(catalog_entries().await).unwrap_or_else(|_| serde_json::json!([]))
}

pub async fn read_skill(plugin_id: &str, skill_id: &str) -> Option<PluginRuntimeSkill> {
    if !valid_id(plugin_id) || !valid_id(skill_id) {
        return None;
    }
    skills()
        .read()
        .await
        .get(&(plugin_id.to_owned(), skill_id.to_owned()))
        .cloned()
}

async fn materialize_http(
    Json(request): Json<MaterializeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let count = materialize(request.skills)
        .await
        .map_err(|message| bad_request(&message))?;
    Ok(Json(serde_json::json!({
        "materialized": count,
        "status": "ok"
    })))
}

async fn catalog_http() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "plugins": catalog_entries().await
    }))
}

async fn read_skill_http(
    Json(request): Json<SkillReadRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if !valid_id(&request.plugin_id) || !valid_id(&request.skill_id) {
        return Err(bad_request(
            "plugin_id and skill_id must be valid identifiers",
        ));
    }
    let skill = read_skill(&request.plugin_id, &request.skill_id)
        .await
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "plugin skill is not enabled or installed"
                })),
            )
        })?;
    Ok(Json(serde_json::json!({ "skill": skill })))
}

async fn catalog_entries() -> Vec<PluginCatalogEntry> {
    let guard = skills().read().await;
    let mut grouped: BTreeMap<String, PluginCatalogEntry> = BTreeMap::new();
    for skill in guard.values() {
        let plugin = grouped
            .entry(skill.plugin_id.clone())
            .or_insert_with(|| PluginCatalogEntry {
                id: skill.plugin_id.clone(),
                name: skill.plugin_name.clone(),
                version: skill.plugin_version.clone(),
                publisher: skill.publisher.clone(),
                skills: Vec::new(),
            });
        plugin.skills.push(SkillCatalogEntry {
            id: skill.skill_id.clone(),
            name: skill.skill_name.clone(),
            description: skill.description.clone(),
            content_hash: skill.content_hash.clone(),
            bytes: skill.content.len(),
        });
    }
    grouped.into_values().collect()
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
        || value.len() > max
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
        assert!(value.to_string().find("Use the issue fields").is_none());

        let skill = read_skill("jira", "triage").await.unwrap();
        assert_eq!(skill.content, "# Triage\nUse the issue fields.");
        assert!(read_skill("jira", "missing").await.is_none());
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
}
