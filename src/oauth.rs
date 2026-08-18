use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{Jwk, JwkSet},
};
use serde::Deserialize;
use tokio::sync::RwLock;
use url::Url;

use crate::config::{Config, OAuthConfig};

pub const READ_SCOPE: &str = "sourcenerve:read";
pub const WRITE_SCOPE: &str = "sourcenerve:write";
const MAX_DISCOVERY_BYTES: u64 = 256 * 1024;
const MAX_JWKS_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Debug)]
pub struct OAuthPrincipal {
    scopes: Arc<HashSet<String>>,
    grants: Arc<HashMap<String, GrantAccess>>,
}

impl OAuthPrincipal {
    pub fn can_read(&self, workspace: &str) -> bool {
        self.scopes.contains(READ_SCOPE) && self.grants.contains_key(workspace)
    }

    pub fn can_write(&self, workspace: &str) -> bool {
        self.scopes.contains(WRITE_SCOPE)
            && matches!(self.grants.get(workspace), Some(GrantAccess::ReadWrite))
    }

    pub fn has_any_write(&self) -> bool {
        self.scopes.contains(WRITE_SCOPE)
            && self
                .grants
                .values()
                .any(|access| *access == GrantAccess::ReadWrite)
    }

    pub fn workspace_access(&self, workspace: &str) -> Option<GrantAccess> {
        self.grants.get(workspace).copied()
    }

    #[cfg(test)]
    pub(crate) fn from_parts_for_test(
        scopes: HashSet<String>,
        grants: HashMap<String, GrantAccess>,
    ) -> Self {
        Self {
            scopes: Arc::new(scopes),
            grants: Arc::new(grants),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Principal {
    Operator,
    OAuth(OAuthPrincipal),
}

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    issuer: Url,
    resource: Url,
    metadata_url: Url,
    discovery: DiscoveryDocument,
    client: reqwest::Client,
    jwks: RwLock<JwkSet>,
    grants: HashMap<String, HashMap<String, GrantAccess>>,
    allow_operator_bearer: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AccessClaims {
    sub: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    InvalidToken,
    InsufficientScope,
}

impl Runtime {
    pub async fn from_config(cfg: &Config) -> Result<Option<Self>> {
        let (Some(issuer), Some(resource)) =
            (cfg.oauth.issuer.as_deref(), cfg.oauth.resource.as_deref())
        else {
            return Ok(None);
        };

        let issuer = parse_public_https_url("oauth.issuer", issuer)?;
        let resource = parse_public_https_url("oauth.resource", resource)?;
        if resource.path() != "/mcp" {
            bail!("oauth.resource must identify the existing public /mcp endpoint");
        }

        let metadata_url = protected_resource_metadata_url(&resource);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .user_agent(format!("sourcenerve/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .context("failed to build OAuth HTTP client")?;

        let discovery_url = oidc_discovery_url(&issuer);
        let discovery: DiscoveryDocument =
            fetch_json_bounded(&client, discovery_url.as_str(), MAX_DISCOVERY_BYTES)
                .await
                .context("failed to load OAuth/OIDC discovery metadata")?;
        validate_discovery(&issuer, &discovery)?;

        let jwks_uri = parse_public_https_url("OIDC jwks_uri", &discovery.jwks_uri)?;
        require_same_origin("OIDC jwks_uri", &issuer, &jwks_uri)?;
        let jwks: JwkSet = fetch_json_bounded(&client, jwks_uri.as_str(), MAX_JWKS_BYTES)
            .await
            .context("failed to load OAuth/OIDC JWKS")?;
        if jwks.keys.is_empty() {
            bail!("OAuth/OIDC JWKS must contain at least one public key");
        }

        let grants = build_grants(&cfg.oauth)?;
        Ok(Some(Self {
            inner: Arc::new(RuntimeInner {
                issuer,
                resource,
                metadata_url,
                discovery,
                client,
                jwks: RwLock::new(jwks),
                grants,
                allow_operator_bearer: cfg.oauth.allow_operator_bearer,
            }),
        }))
    }

    pub fn allow_operator_bearer(&self) -> bool {
        self.inner.allow_operator_bearer
    }

    pub fn metadata_url(&self) -> &str {
        self.inner.metadata_url.as_str()
    }

    pub fn protected_resource_metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "resource": self.inner.resource.as_str(),
            "authorization_servers": [self.inner.issuer.as_str()],
            "scopes_supported": [READ_SCOPE, WRITE_SCOPE],
            "bearer_methods_supported": ["header"],
            "resource_name": "SourceNerve MCP"
        })
    }

    pub async fn authenticate(&self, token: &str) -> std::result::Result<OAuthPrincipal, AuthError> {
        if token.is_empty() || token.len() > 16 * 1024 {
            return Err(AuthError::InvalidToken);
        }
        let header = decode_header(token).map_err(|_| AuthError::InvalidToken)?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::InvalidToken);
        }
        let kid = header.kid.as_deref().ok_or(AuthError::InvalidToken)?;
        let jwk = self.key_for(kid).await.map_err(|_| AuthError::InvalidToken)?;
        let decoding_key = DecodingKey::from_jwk(&jwk).map_err(|_| AuthError::InvalidToken)?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[self.inner.issuer.as_str()]);
        validation.set_audience(&[self.inner.resource.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = 60;

        let token_data = decode::<AccessClaims>(token, &decoding_key, &validation)
            .map_err(|_| AuthError::InvalidToken)?;
        if token_data.claims.sub.is_empty() || token_data.claims.sub.len() > 512 {
            return Err(AuthError::InvalidToken);
        }

        let mut scopes = HashSet::new();
        if let Some(scope) = token_data.claims.scope {
            scopes.extend(scope.split_ascii_whitespace().map(str::to_owned));
        }
        scopes.extend(token_data.claims.permissions);
        if !scopes.contains(READ_SCOPE) {
            return Err(AuthError::InsufficientScope);
        }

        let grants = self
            .inner
            .grants
            .get(&token_data.claims.sub)
            .cloned()
            .unwrap_or_default();
        Ok(OAuthPrincipal {
            scopes: Arc::new(scopes),
            grants: Arc::new(grants),
        })
    }

    async fn key_for(&self, kid: &str) -> Result<Jwk> {
        if let Some(key) = self.inner.jwks.read().await.find(kid).cloned() {
            return Ok(key);
        }
        let jwks_uri = parse_public_https_url("OIDC jwks_uri", &self.inner.discovery.jwks_uri)?;
        let fresh: JwkSet =
            fetch_json_bounded(&self.inner.client, jwks_uri.as_str(), MAX_JWKS_BYTES).await?;
        let key = fresh
            .find(kid)
            .cloned()
            .context("JWT kid is not present in provider JWKS")?;
        *self.inner.jwks.write().await = fresh;
        Ok(key)
    }
}

fn build_grants(cfg: &OAuthConfig) -> Result<HashMap<String, HashMap<String, GrantAccess>>> {
    let mut by_subject: HashMap<String, HashMap<String, GrantAccess>> = HashMap::new();
    for grant in &cfg.grants {
        let access = match grant.access.as_str() {
            "read-only" => GrantAccess::ReadOnly,
            "read-write" => GrantAccess::ReadWrite,
            _ => bail!("invalid oauth grant access after config validation"),
        };
        by_subject
            .entry(grant.subject.clone())
            .or_default()
            .insert(grant.workspace.clone(), access);
    }
    Ok(by_subject)
}

fn parse_public_https_url(name: &str, raw: &str) -> Result<Url> {
    let url = Url::parse(raw).with_context(|| format!("{name} must be an absolute URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("{name} must be a credential-free HTTPS URL without query or fragment");
    }
    Ok(url)
}

fn oidc_discovery_url(issuer: &Url) -> Url {
    let mut value = issuer.clone();
    let base = issuer.path().trim_end_matches('/');
    value.set_path(&format!("{base}/.well-known/openid-configuration"));
    value
}

fn protected_resource_metadata_url(resource: &Url) -> Url {
    let mut value = resource.clone();
    let resource_path = resource.path().trim_start_matches('/');
    value.set_path(&format!("/.well-known/oauth-protected-resource/{resource_path}"));
    value
}

fn normalized_url(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn require_same_origin(name: &str, issuer: &Url, value: &Url) -> Result<()> {
    if !same_origin(issuer, value) {
        bail!("{name} must stay on the configured OAuth issuer origin");
    }
    Ok(())
}

fn validate_discovery(issuer: &Url, metadata: &DiscoveryDocument) -> Result<()> {
    if normalized_url(&metadata.issuer) != normalized_url(issuer.as_str()) {
        bail!("OIDC discovery issuer does not match oauth.issuer");
    }
    for (name, raw) in [
        ("authorization_endpoint", metadata.authorization_endpoint.as_str()),
        ("token_endpoint", metadata.token_endpoint.as_str()),
        ("jwks_uri", metadata.jwks_uri.as_str()),
    ] {
        let value = parse_public_https_url(name, raw)?;
        require_same_origin(name, issuer, &value)?;
    }
    if let Some(registration) = metadata.registration_endpoint.as_deref() {
        let value = parse_public_https_url("registration_endpoint", registration)?;
        require_same_origin("registration_endpoint", issuer, &value)?;
    }
    if !metadata
        .scopes_supported
        .iter()
        .any(|scope| scope == "offline_access")
    {
        bail!(
            "OAuth/OIDC provider discovery must advertise offline_access for refresh-token capable ChatGPT connections"
        );
    }
    Ok(())
}

async fn fetch_json_bounded<T>(client: &reqwest::Client, url: &str, max_bytes: u64) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed GET {url}"))?
        .error_for_status()
        .with_context(|| format!("non-success response from {url}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        bail!("response from {url} exceeds configured metadata bound");
    }
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > max_bytes {
        bail!("response from {url} exceeds configured metadata bound");
    }
    serde_json::from_slice(&bytes).with_context(|| format!("invalid JSON from {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_url_tracks_mcp_resource_path() {
        let resource = Url::parse("https://sourcenerve.example.test/mcp").unwrap();
        assert_eq!(
            protected_resource_metadata_url(&resource).as_str(),
            "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp"
        );
    }

    #[test]
    fn issuer_discovery_path_is_stable() {
        let issuer = Url::parse("https://tenant.example.test/").unwrap();
        assert_eq!(
            oidc_discovery_url(&issuer).as_str(),
            "https://tenant.example.test/.well-known/openid-configuration"
        );
    }

    #[test]
    fn oauth_principal_requires_scope_and_exact_workspace_grant() {
        let principal = OAuthPrincipal::from_parts_for_test(
            HashSet::from([READ_SCOPE.into(), WRITE_SCOPE.into()]),
            HashMap::from([
                ("a".into(), GrantAccess::ReadOnly),
                ("b".into(), GrantAccess::ReadWrite),
            ]),
        );
        assert!(principal.can_read("a"));
        assert!(!principal.can_write("a"));
        assert!(principal.can_write("b"));
        assert!(!principal.can_read("missing"));
    }
}