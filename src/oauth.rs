use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
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
    pub scopes: Arc<HashSet<String>>,
    pub grants: Arc<HashMap<String, GrantAccess>>,
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
    max_token_lifetime_seconds: u64,
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
    iat: u64,
    exp: u64,
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
                max_token_lifetime_seconds: cfg.oauth.max_token_lifetime_seconds,
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

    pub async fn authenticate(
        &self,
        token: &str,
    ) -> std::result::Result<OAuthPrincipal, AuthError> {
        if token.is_empty() || token.len() > 16 * 1024 {
            return Err(AuthError::InvalidToken);
        }
        let header = decode_header(token).map_err(|_| AuthError::InvalidToken)?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::InvalidToken);
        }
        let kid = header.kid.as_deref().ok_or(AuthError::InvalidToken)?;
        let jwk = self
            .key_for(kid)
            .await
            .map_err(|_| AuthError::InvalidToken)?;
        let decoding_key = DecodingKey::from_jwk(&jwk).map_err(|_| AuthError::InvalidToken)?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[self.inner.issuer.as_str()]);
        validation.set_audience(&[self.inner.resource.as_str()]);
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        validation.leeway = 60;

        let token_data = decode::<AccessClaims>(token, &decoding_key, &validation)
            .map_err(|_| AuthError::InvalidToken)?;
        let now = unix_now().ok_or(AuthError::InvalidToken)?;
        if token_data.claims.sub.is_empty() || token_data.claims.sub.len() > 512 {
            return Err(AuthError::InvalidToken);
        }
        if token_data.claims.iat > now.saturating_add(validation.leeway)
            || token_data.claims.exp <= token_data.claims.iat
            || token_data.claims.exp.saturating_sub(token_data.claims.iat)
                > self.inner.max_token_lifetime_seconds
        {
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
        if std::env::var("SOURCENERVE_DEBUG_AUTH").is_ok() {
            tracing::info!("DEBUG: Token subject: '{}', Available grants keys: {:?}", token_data.claims.sub, self.inner.grants.keys().collect::<Vec<_>>());
        }
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

    #[cfg(test)]
    fn for_test(grants: HashMap<String, HashMap<String, GrantAccess>>) -> Self {
        let issuer = Url::parse("https://issuer.example.test/").unwrap();
        let resource = Url::parse("https://sourcenerve.example.test/mcp").unwrap();
        let metadata_url = protected_resource_metadata_url(&resource);
        let discovery = DiscoveryDocument {
            issuer: issuer.as_str().to_string(),
            authorization_endpoint: "https://issuer.example.test/authorize".into(),
            token_endpoint: "https://issuer.example.test/oauth/token".into(),
            jwks_uri: "https://issuer.example.test/.well-known/jwks.json".into(),
            registration_endpoint: Some("https://issuer.example.test/oidc/register".into()),
            scopes_supported: vec![
                "offline_access".into(),
                READ_SCOPE.into(),
                WRITE_SCOPE.into(),
            ],
        };
        let jwks: JwkSet = serde_json::from_value(serde_json::json!({
            "keys": [{
                "kty": "RSA",
                "kid": "test-key",
                "use": "sig",
                "alg": "RS256",
                "n": "twhiDCzEw01z90n6E5WbnSGGgA3QWkxrQ6UTfEhEc5pf2wfvG1q72QThGEVvQ4xVx9qIBCcMvktrf-ttGq0QRFtCZiyYodtrHWHpZ2-vLUGvt0gBW9b7-Ei6XU2WFD2V1cODfPPu1iQBp9b2UGfe9me_rMP99kTsT_xQl996GMTzs8YF9FiSdwAUlgGvSqfWrCrfxcbKMLOyQXJ5cJ4Rfrdg2WYPXH0Ql2Ux5lvmkabswVRWC8ss90H-ME3MAbMbotA9M_zzTeLDRWG9FLX2_MiaQot4FqfdsGsTm41ryFVYPUv4A_fgSGDAGI3Ktb9yq_sW4ZkK5lkLqrqj-Nt6QQ",
                "e": "AQAB"
            }]
        }))
        .unwrap();
        Self {
            inner: Arc::new(RuntimeInner {
                issuer,
                resource,
                metadata_url,
                discovery,
                client: reqwest::Client::new(),
                jwks: RwLock::new(jwks),
                grants,
                allow_operator_bearer: false,
                max_token_lifetime_seconds: 300,
            }),
        }
    }
}

fn unix_now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
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
    value.set_path(&format!(
        "/.well-known/oauth-protected-resource/{resource_path}"
    ));
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
        (
            "authorization_endpoint",
            metadata.authorization_endpoint.as_str(),
        ),
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
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde::Serialize;

    use super::*;

    const TEST_PRIVATE_KEY: &[u8] = br#"-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3CGIMLMTDTXP3
SfoTlZudIYaADdBaTGtDpRN8SERzml/bB+8bWrvZBOEYRW9DjFXH2ogEJwy+S2t/
620arRBEW0JmLJih22sdYelnb68tQa+3SAFb1vv4SLpdTZYUPZXVw4N88+7WJAGn
1vZQZ972Z7+sw/32ROxP/FCX33oYxPOzxgX0WJJ3ABSWAa9Kp9asKt/Fxsows7JB
cnlwnhF+t2DZZg9cfRCXZTHmW+aRpuzBVFYLyyz3Qf4wTcwBsxui0D0z/PNN4sNF
Yb0Utfb8yJpCi3gWp92waxObjWvIVVg9S/gD9+BIYMAYjcq1v3Kr+xbhmQrmWQuq
uqP423pBAgMBAAECggEAE+PzU8Nhtp+qJIuDg7FUceT8ytm1dLqtRXKhBXaNCcsS
86iPEXfwxgrDs3GIP9z2TXuwIFNmDSABFKuu9aEtDWClfJkIFT7VCyJizPzUGqTy
xYYrr6FTTI4Kwqz1zElNCSfwGBoiMF9FVsoDhoVjM3/e0pWR+btPuvl+gKKmkB5X
pMQlSbIXcJWAt6tJUDww3F4ozyx89ghuFC3yyY36PVRW/Ug5BjI3DUaIJzkm9Op6
k+sX1cPzsgGlkb33jpWZRn+k5jFnogCnWj68AruBuWcAE98cSeQGO2M3J26oHPzp
43OF4iWnXrbHx0mXF4XqTYv+pY8DciFzqBtGna3n6QKBgQD4wNbDE/qLDs2Et3B0
4MPORFE1ju7+Rg1tVw7toj9bkDZctApvxADFAOTtjgXW/f+iL/zm5UU9Zks2Zuyq
JD7B2wOP5odhzEPMRjP1zjzzaM3oJ0hCR3hYXI67TQ5joVs3FdmvfRrAORcGNbTD
dpyVWjmmZbMhZo7+Hpcx/bcKYwKBgQC8XWlBqPZlDihOjR2qb3GwP6CKwBsnDeW+
daN+TwaCVvBvIbhHTL2rlEmUS6L6AeGKUd/j3mzdmGRtg86AhjXiJvLfRZzBMM5v
c7WRvIiGmca87jd8g1SckbS20Y7vlCQU63CCjcgmlqa75YfHcLQ7cU36K1Jbnoag
uNIKNaRYCwKBgQDZA6uZPxnKLVzhFwQ2A0zv66wJlKwuC0F1jYkJig3KPPMgRzX/
sbiWJiSSlt/DY46cmU8CxSx114Nwb7Sy7rINf5wI865ShNj1Ip38KTQFiv5wNa0V
nbKBLCadgyk1hDTGxvpF3lfzMRtEIKCWEimjJra602jGj+naCygOxfDlTwKBgG16
8XF7TfKAXwcA2Aw2h+KDqMDcVSvG1RB0+Vixf7wD4e0FsUCnptnx7y4lJA2hSECH
w9SCc838A+rvH/ftiaXvM1x37lsPDf0TSKXy6XsqJ6up3VAeWPBDc8CKXkR7WtlZ
2mPXGkzrZO9ywg82P1sJSOQth8m+gsspgNL0SJfvAoGBAIKgijhfECr57+zrZTO9
b6nf0oZL+OvlJEa4tOG4wgxb3X2kYXDfl2nTj7fgIvyK/D/tN71FJOuowrfzwcim
C4Hq+kmcW6zjJ1URPSor+gxERpColfYVkQVAii91tuWfiQhZHX3BRoJ7A6Zljjcq
8dsg6TUxNc8JTfjt0Fi9g1/o
-----END PRIVATE KEY-----"#;

    #[derive(Serialize)]
    struct TestClaims<'a> {
        sub: &'a str,
        iss: &'a str,
        aud: &'a str,
        iat: u64,
        exp: u64,
        scope: &'a str,
    }

    fn runtime() -> Runtime {
        Runtime::for_test(HashMap::from([(
            "auth0|user-a".to_string(),
            HashMap::from([("workspace-a".to_string(), GrantAccess::ReadWrite)]),
        )]))
    }

    fn signed_token(sub: &str, audience: &str, scope: &str, iat: u64, exp: u64) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        encode(
            &header,
            &TestClaims {
                sub,
                iss: "https://issuer.example.test/",
                aud: audience,
                iat,
                exp,
                scope,
            },
            &EncodingKey::from_rsa_pem(TEST_PRIVATE_KEY).unwrap(),
        )
        .unwrap()
    }

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

    #[tokio::test]
    async fn valid_resource_token_authenticates_only_configured_subject_grant() {
        let now = unix_now().unwrap();
        let token = signed_token(
            "auth0|user-a",
            "https://sourcenerve.example.test/mcp",
            "sourcenerve:read sourcenerve:write",
            now,
            now + 120,
        );
        let principal = runtime().authenticate(&token).await.unwrap();
        assert!(principal.can_read("workspace-a"));
        assert!(principal.can_write("workspace-a"));
        assert!(!principal.can_read("workspace-b"));
    }

    #[tokio::test]
    async fn wrong_audience_and_expired_tokens_fail_closed() {
        let now = unix_now().unwrap();
        let wrong_audience = signed_token(
            "auth0|user-a",
            "https://other.example.test/mcp",
            READ_SCOPE,
            now,
            now + 120,
        );
        assert_eq!(
            runtime().authenticate(&wrong_audience).await.unwrap_err(),
            AuthError::InvalidToken
        );

        let expired = signed_token(
            "auth0|user-a",
            "https://sourcenerve.example.test/mcp",
            READ_SCOPE,
            now - 200,
            now - 100,
        );
        assert_eq!(
            runtime().authenticate(&expired).await.unwrap_err(),
            AuthError::InvalidToken
        );
    }

    #[tokio::test]
    async fn missing_scope_future_iat_and_excessive_lifetime_fail_closed() {
        let now = unix_now().unwrap();
        let missing_scope = signed_token(
            "auth0|user-a",
            "https://sourcenerve.example.test/mcp",
            "openid profile",
            now,
            now + 120,
        );
        assert_eq!(
            runtime().authenticate(&missing_scope).await.unwrap_err(),
            AuthError::InsufficientScope
        );

        let future = signed_token(
            "auth0|user-a",
            "https://sourcenerve.example.test/mcp",
            READ_SCOPE,
            now + 120,
            now + 240,
        );
        assert_eq!(
            runtime().authenticate(&future).await.unwrap_err(),
            AuthError::InvalidToken
        );

        let long_lived = signed_token(
            "auth0|user-a",
            "https://sourcenerve.example.test/mcp",
            READ_SCOPE,
            now,
            now + 600,
        );
        assert_eq!(
            runtime().authenticate(&long_lived).await.unwrap_err(),
            AuthError::InvalidToken
        );
    }
}
