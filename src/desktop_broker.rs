use std::{
    collections::{HashMap, VecDeque},
    env,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, bail};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use reqwest::Method;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::oauth::{self, AuthError};

const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
const LOCAL_ORIGIN_SERVICE: &str = "http://127.0.0.1:7331";
const MAX_CLOUDFLARE_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_JWT_PAYLOAD_BYTES: usize = 16 * 1024;
const MUTATION_RATE_LIMIT: usize = 10;
const MUTATION_RATE_WINDOW: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub struct Runtime {
    cloudflare: CloudflareClient,
    hostname_suffix: Arc<str>,
    limiter: Arc<Mutex<RateLimiter>>,
    mutation_lock: Arc<Mutex<()>>,
}

impl Runtime {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        if !env_bool("SOURCENERVE_DESKTOP_BROKER_ENABLED")? {
            return Ok(None);
        }

        let account_id = required_env("SOURCENERVE_CLOUDFLARE_ACCOUNT_ID")?;
        let zone_id = required_env("SOURCENERVE_CLOUDFLARE_ZONE_ID")?;
        let api_token = required_env("SOURCENERVE_CLOUDFLARE_API_TOKEN")?;
        let hostname_suffix = required_env("SOURCENERVE_DESKTOP_HOSTNAME_SUFFIX")?;

        validate_cloudflare_id("SOURCENERVE_CLOUDFLARE_ACCOUNT_ID", &account_id)?;
        validate_cloudflare_id("SOURCENERVE_CLOUDFLARE_ZONE_ID", &zone_id)?;
        if api_token.len() < 20 || api_token.len() > 4096 || !api_token.is_ascii() {
            bail!("SOURCENERVE_CLOUDFLARE_API_TOKEN must be 20-4096 ASCII bytes");
        }
        validate_hostname_suffix(&hostname_suffix)?;

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .user_agent(format!(
                "sourcenerve-desktop-broker/{}",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .context("failed to build Desktop broker Cloudflare client")?;

        Ok(Some(Self {
            cloudflare: CloudflareClient {
                client,
                account_id: Arc::from(account_id),
                zone_id: Arc::from(zone_id),
                api_token: Arc::from(api_token),
            },
            hostname_suffix: Arc::from(hostname_suffix),
            limiter: Arc::new(Mutex::new(RateLimiter::default())),
            mutation_lock: Arc::new(Mutex::new(())),
        }))
    }
}

#[derive(Clone)]
struct BrokerState {
    db: SqlitePool,
    oauth: oauth::Runtime,
    runtime: Runtime,
}

pub fn router(db: SqlitePool, oauth: oauth::Runtime, runtime: Runtime) -> Router {
    Router::new()
        .route("/v1/desktop/enroll", post(enroll))
        .route("/v1/desktop/tunnel/rotate", post(rotate_tunnel))
        .route("/v1/desktop/revoke", post(revoke))
        .route("/v1/desktop/bootstrap-status", get(status))
        .with_state(BrokerState { db, oauth, runtime })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    installation_id: String,
    client_version: Option<String>,
    platform: Option<String>,
    arch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationRequest {
    installation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    installation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentResponse {
    installation_id: String,
    hostname: String,
    tunnel_id: String,
    tunnel_token: String,
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    installation_id: String,
    hostname: String,
    tunnel_id: String,
    status: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct MutationResponse {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: &'static str,
    message: &'static str,
}

#[derive(Debug, Clone, FromRow)]
struct InstallationRow {
    installation_id: String,
    subject: String,
    tunnel_id: String,
    dns_record_id: String,
    hostname: String,
    status: String,
    updated_at: String,
}

async fn enroll(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<EnrollmentRequest>,
) -> Response {
    let subject = match authenticate_subject(&state.oauth, &headers).await {
        Ok(subject) => subject,
        Err(response) => return response,
    };
    if let Err(response) = validate_installation_id(&request.installation_id) {
        return response;
    }
    if let Some(value) = request.client_version.as_deref()
        && !valid_metadata(value, 128)
    {
        return bad_request("clientVersion must be 1-128 printable ASCII bytes");
    }
    if let Some(value) = request.platform.as_deref()
        && !valid_metadata(value, 64)
    {
        return bad_request("platform must be 1-64 printable ASCII bytes");
    }
    if let Some(value) = request.arch.as_deref()
        && !valid_metadata(value, 64)
    {
        return bad_request("arch must be 1-64 printable ASCII bytes");
    }
    if !allow_mutation(
        &state.runtime,
        &subject,
        &request.installation_id,
        "enroll",
    )
    .await
    {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many Desktop enrollment mutations; retry later",
        );
    }

    let _guard = state.runtime.mutation_lock.lock().await;
    match load_installation(&state.db, &request.installation_id).await {
        Ok(Some(existing)) => {
            if existing.subject != subject {
                return not_found();
            }
            if existing.status == "revoked" {
                return error_response(
                    StatusCode::CONFLICT,
                    "installation_revoked",
                    "installation is revoked; create a new installation identity",
                );
            }
            return match state.runtime.cloudflare.tunnel_token(&existing.tunnel_id).await {
                Ok(token) => Json(EnrollmentResponse {
                    installation_id: existing.installation_id,
                    hostname: existing.hostname,
                    tunnel_id: existing.tunnel_id,
                    tunnel_token: token,
                    status: "active",
                })
                .into_response(),
                Err(error) => {
                    tracing::warn!(error = %error.safe_message(), "Desktop broker failed to refresh existing tunnel token");
                    upstream_error()
                }
            };
        }
        Ok(None) => {}
        Err(error) => {
            tracing::error!(error = %error, "Desktop broker failed to query installation");
            return internal_error();
        }
    }

    let hostname = installation_hostname(
        &subject,
        &request.installation_id,
        &state.runtime.hostname_suffix,
    );
    let tunnel_name = tunnel_name(&subject, &request.installation_id);
    let tunnel = match state.runtime.cloudflare.create_tunnel(&tunnel_name).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error.safe_message(), "Desktop broker failed to create Cloudflare tunnel");
            return upstream_error();
        }
    };

    if let Err(error) = state
        .runtime
        .cloudflare
        .configure_tunnel(&tunnel.id, &hostname)
        .await
    {
        tracing::warn!(error = %error.safe_message(), "Desktop broker failed to configure Cloudflare tunnel");
        let _ = state.runtime.cloudflare.delete_tunnel(&tunnel.id).await;
        return upstream_error();
    }

    let dns_record_id = match state
        .runtime
        .cloudflare
        .create_dns_record(&hostname, &tunnel.id)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error.safe_message(), "Desktop broker failed to create Cloudflare DNS route");
            let _ = state.runtime.cloudflare.delete_tunnel(&tunnel.id).await;
            return upstream_error();
        }
    };

    let token = match tunnel.token {
        Some(token) => token,
        None => match state.runtime.cloudflare.tunnel_token(&tunnel.id).await {
            Ok(token) => token,
            Err(error) => {
                tracing::warn!(error = %error.safe_message(), "Desktop broker failed to obtain Cloudflare tunnel token");
                let _ = state
                    .runtime
                    .cloudflare
                    .delete_dns_record(&dns_record_id)
                    .await;
                let _ = state.runtime.cloudflare.delete_tunnel(&tunnel.id).await;
                return upstream_error();
            }
        },
    };

    if let Err(error) = sqlx::query(
        "INSERT INTO desktop_installations \
         (installation_id, subject, tunnel_id, dns_record_id, hostname, status) \
         VALUES (?, ?, ?, ?, ?, 'active')",
    )
    .bind(&request.installation_id)
    .bind(&subject)
    .bind(&tunnel.id)
    .bind(&dns_record_id)
    .bind(&hostname)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %error, "Desktop broker failed to persist installation assignment");
        let _ = state
            .runtime
            .cloudflare
            .delete_dns_record(&dns_record_id)
            .await;
        let _ = state.runtime.cloudflare.delete_tunnel(&tunnel.id).await;
        return internal_error();
    }

    Json(EnrollmentResponse {
        installation_id: request.installation_id,
        hostname,
        tunnel_id: tunnel.id,
        tunnel_token: token,
        status: "active",
    })
    .into_response()
}

async fn rotate_tunnel(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<InstallationRequest>,
) -> Response {
    let subject = match authenticate_subject(&state.oauth, &headers).await {
        Ok(subject) => subject,
        Err(response) => return response,
    };
    if let Err(response) = validate_installation_id(&request.installation_id) {
        return response;
    }
    if !allow_mutation(
        &state.runtime,
        &subject,
        &request.installation_id,
        "rotate",
    )
    .await
    {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many Desktop tunnel rotations; retry later",
        );
    }

    let _guard = state.runtime.mutation_lock.lock().await;
    let installation =
        match owned_active_installation(&state.db, &subject, &request.installation_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };

    let new_secret = random_tunnel_secret();
    if let Err(error) = state
        .runtime
        .cloudflare
        .rotate_tunnel_secret(&installation.tunnel_id, &new_secret)
        .await
    {
        tracing::warn!(error = %error.safe_message(), "Desktop broker failed to rotate Cloudflare tunnel secret");
        return upstream_error();
    }

    let token = match state
        .runtime
        .cloudflare
        .tunnel_token(&installation.tunnel_id)
        .await
    {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(error = %error.safe_message(), "Desktop broker failed to obtain rotated tunnel token");
            return upstream_error();
        }
    };

    if let Err(error) = state
        .runtime
        .cloudflare
        .disconnect_tunnel(&installation.tunnel_id)
        .await
    {
        tracing::warn!(error = %error.safe_message(), "Desktop broker could not force-disconnect old Cloudflare connectors after rotation");
    }

    if let Err(error) = sqlx::query(
        "UPDATE desktop_installations SET updated_at = CURRENT_TIMESTAMP \
         WHERE installation_id = ? AND subject = ? AND status = 'active'",
    )
    .bind(&request.installation_id)
    .bind(&subject)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %error, "Desktop broker failed to persist tunnel rotation timestamp");
        return internal_error();
    }

    Json(EnrollmentResponse {
        installation_id: installation.installation_id,
        hostname: installation.hostname,
        tunnel_id: installation.tunnel_id,
        tunnel_token: token,
        status: "active",
    })
    .into_response()
}

async fn revoke(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<InstallationRequest>,
) -> Response {
    let subject = match authenticate_subject(&state.oauth, &headers).await {
        Ok(subject) => subject,
        Err(response) => return response,
    };
    if let Err(response) = validate_installation_id(&request.installation_id) {
        return response;
    }
    if !allow_mutation(
        &state.runtime,
        &subject,
        &request.installation_id,
        "revoke",
    )
    .await
    {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many Desktop revocation mutations; retry later",
        );
    }

    let _guard = state.runtime.mutation_lock.lock().await;
    let installation = match load_installation(&state.db, &request.installation_id).await {
        Ok(Some(value)) if value.subject == subject => value,
        Ok(Some(_)) | Ok(None) => return not_found(),
        Err(error) => {
            tracing::error!(error = %error, "Desktop broker failed to query installation for revoke");
            return internal_error();
        }
    };
    if installation.status == "revoked" {
        return Json(MutationResponse { status: "revoked" }).into_response();
    }

    if let Err(error) = state
        .runtime
        .cloudflare
        .delete_dns_record(&installation.dns_record_id)
        .await
    {
        tracing::warn!(error = %error.safe_message(), "Desktop broker failed to delete Cloudflare DNS route during revoke");
        return upstream_error();
    }
    if let Err(error) = state
        .runtime
        .cloudflare
        .delete_tunnel(&installation.tunnel_id)
        .await
    {
        tracing::warn!(error = %error.safe_message(), "Desktop broker failed to delete Cloudflare tunnel during revoke");
        return upstream_error();
    }

    if let Err(error) = sqlx::query(
        "UPDATE desktop_installations \
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP \
         WHERE installation_id = ? AND subject = ?",
    )
    .bind(&request.installation_id)
    .bind(&subject)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %error, "Desktop broker failed to persist revoked installation");
        return internal_error();
    }

    Json(MutationResponse { status: "revoked" }).into_response()
}

async fn status(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Query(query): Query<StatusQuery>,
) -> Response {
    let subject = match authenticate_subject(&state.oauth, &headers).await {
        Ok(subject) => subject,
        Err(response) => return response,
    };
    if let Err(response) = validate_installation_id(&query.installation_id) {
        return response;
    }

    match load_installation(&state.db, &query.installation_id).await {
        Ok(Some(value)) if value.subject == subject => Json(StatusResponse {
            installation_id: value.installation_id,
            hostname: value.hostname,
            tunnel_id: value.tunnel_id,
            status: value.status,
            updated_at: value.updated_at,
        })
        .into_response(),
        Ok(Some(_)) | Ok(None) => not_found(),
        Err(error) => {
            tracing::error!(error = %error, "Desktop broker failed to query installation status");
            internal_error()
        }
    }
}

async fn authenticate_subject(
    runtime: &oauth::Runtime,
    headers: &HeaderMap,
) -> std::result::Result<String, Response> {
    let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "valid SourceNerve OAuth bearer token required",
        ));
    };

    match runtime.authenticate(token).await {
        Ok(_) => verified_subject_from_authenticated_token(token).ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "SourceNerve OAuth bearer token subject is invalid",
            )
        }),
        Err(AuthError::InvalidToken) => Err(error_response(
            StatusCode::UNAUTHORIZED,
            "invalid_token",
            "SourceNerve OAuth bearer token is invalid or expired",
        )),
        Err(AuthError::InsufficientScope) => Err(error_response(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            "SourceNerve read scope is required for Desktop enrollment",
        )),
    }
}

#[derive(Deserialize)]
struct VerifiedSubjectClaims {
    sub: String,
}

fn verified_subject_from_authenticated_token(token: &str) -> Option<String> {
    // `oauth::Runtime::authenticate` has already verified this exact JWT's signature,
    // issuer, audience, lifetime, required claims and scope. Decoding the same payload
    // here only recovers `sub` for installation ownership; it is not an auth decision.
    let mut segments = token.split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    let _signature = segments.next()?;
    if segments.next().is_some() || payload.len() > MAX_JWT_PAYLOAD_BYTES * 2 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    if bytes.len() > MAX_JWT_PAYLOAD_BYTES {
        return None;
    }
    let claims: VerifiedSubjectClaims = serde_json::from_slice(&bytes).ok()?;
    if claims.sub.is_empty()
        || claims.sub.len() > 512
        || claims.sub.chars().any(char::is_control)
    {
        return None;
    }
    Some(claims.sub)
}

async fn owned_active_installation(
    db: &SqlitePool,
    subject: &str,
    installation_id: &str,
) -> std::result::Result<InstallationRow, Response> {
    match load_installation(db, installation_id).await {
        Ok(Some(value)) if value.subject == subject && value.status == "active" => Ok(value),
        Ok(Some(value)) if value.subject == subject && value.status == "revoked" => {
            Err(error_response(
                StatusCode::CONFLICT,
                "installation_revoked",
                "installation is revoked",
            ))
        }
        Ok(Some(_)) | Ok(None) => Err(not_found()),
        Err(error) => {
            tracing::error!(error = %error, "Desktop broker failed to query owned installation");
            Err(internal_error())
        }
    }
}

async fn load_installation(
    db: &SqlitePool,
    installation_id: &str,
) -> anyhow::Result<Option<InstallationRow>> {
    sqlx::query_as::<_, InstallationRow>(
        "SELECT installation_id, subject, tunnel_id, dns_record_id, hostname, status, updated_at \
         FROM desktop_installations WHERE installation_id = ?",
    )
    .bind(installation_id)
    .fetch_optional(db)
    .await
    .context("failed to query desktop_installations")
}

async fn allow_mutation(
    runtime: &Runtime,
    subject: &str,
    installation_id: &str,
    operation: &str,
) -> bool {
    runtime.limiter.lock().await.allow(
        format!("{subject}\0{installation_id}\0{operation}"),
        MUTATION_RATE_LIMIT,
        MUTATION_RATE_WINDOW,
    )
}

#[derive(Default)]
struct RateLimiter {
    entries: HashMap<String, VecDeque<Instant>>,
}

impl RateLimiter {
    fn allow(&mut self, key: String, limit: usize, window: Duration) -> bool {
        let now = Instant::now();
        let queue = self.entries.entry(key).or_default();
        while queue
            .front()
            .is_some_and(|instant| now.duration_since(*instant) >= window)
        {
            queue.pop_front();
        }
        if queue.len() >= limit {
            return false;
        }
        queue.push_back(now);
        true
    }
}

#[derive(Clone)]
struct CloudflareClient {
    client: reqwest::Client,
    account_id: Arc<str>,
    zone_id: Arc<str>,
    api_token: Arc<str>,
}

#[derive(Debug)]
struct CloudflareError {
    status: Option<StatusCode>,
    context: &'static str,
}

impl CloudflareError {
    fn safe_message(&self) -> String {
        match self.status {
            Some(status) => format!("{} ({status})", self.context),
            None => self.context.to_owned(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct CloudflareEnvelope<T> {
    success: bool,
    result: T,
}

#[derive(Debug, Deserialize)]
struct TunnelResult {
    id: String,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DnsResult {
    id: String,
}

struct CreatedTunnel {
    id: String,
    token: Option<String>,
}

impl CloudflareClient {
    async fn create_tunnel(
        &self,
        name: &str,
    ) -> std::result::Result<CreatedTunnel, CloudflareError> {
        let result: TunnelResult = self
            .json(
                Method::POST,
                &format!("/accounts/{}/cfd_tunnel", self.account_id),
                Some(serde_json::json!({
                    "name": name,
                    "config_src": "cloudflare"
                })),
                "Cloudflare tunnel creation failed",
            )
            .await?;
        if result.id.is_empty() || result.id.len() > 64 {
            return Err(CloudflareError {
                status: None,
                context: "Cloudflare returned an invalid tunnel id",
            });
        }
        Ok(CreatedTunnel {
            id: result.id,
            token: result.token.filter(|token| valid_tunnel_token(token)),
        })
    }

    async fn configure_tunnel(
        &self,
        tunnel_id: &str,
        hostname: &str,
    ) -> std::result::Result<(), CloudflareError> {
        let _: serde_json::Value = self
            .json(
                Method::PUT,
                &format!(
                    "/accounts/{}/cfd_tunnel/{tunnel_id}/configurations",
                    self.account_id
                ),
                Some(serde_json::json!({
                    "config": {
                        "ingress": [
                            {
                                "hostname": hostname,
                                "service": LOCAL_ORIGIN_SERVICE
                            },
                            {
                                "service": "http_status:404"
                            }
                        ]
                    }
                })),
                "Cloudflare tunnel configuration failed",
            )
            .await?;
        Ok(())
    }

    async fn create_dns_record(
        &self,
        hostname: &str,
        tunnel_id: &str,
    ) -> std::result::Result<String, CloudflareError> {
        let result: DnsResult = self
            .json(
                Method::POST,
                &format!("/zones/{}/dns_records", self.zone_id),
                Some(serde_json::json!({
                    "type": "CNAME",
                    "proxied": true,
                    "name": hostname,
                    "content": format!("{tunnel_id}.cfargotunnel.com")
                })),
                "Cloudflare DNS route creation failed",
            )
            .await?;
        if result.id.is_empty() || result.id.len() > 128 {
            return Err(CloudflareError {
                status: None,
                context: "Cloudflare returned an invalid DNS record id",
            });
        }
        Ok(result.id)
    }

    async fn tunnel_token(
        &self,
        tunnel_id: &str,
    ) -> std::result::Result<String, CloudflareError> {
        let token: String = self
            .json(
                Method::GET,
                &format!(
                    "/accounts/{}/cfd_tunnel/{tunnel_id}/token",
                    self.account_id
                ),
                None,
                "Cloudflare tunnel token lookup failed",
            )
            .await?;
        if !valid_tunnel_token(&token) {
            return Err(CloudflareError {
                status: None,
                context: "Cloudflare returned an invalid tunnel token",
            });
        }
        Ok(token)
    }

    async fn rotate_tunnel_secret(
        &self,
        tunnel_id: &str,
        secret: &str,
    ) -> std::result::Result<(), CloudflareError> {
        let _: TunnelResult = self
            .json(
                Method::PATCH,
                &format!("/accounts/{}/cfd_tunnel/{tunnel_id}", self.account_id),
                Some(serde_json::json!({ "tunnel_secret": secret })),
                "Cloudflare tunnel secret rotation failed",
            )
            .await?;
        Ok(())
    }

    async fn disconnect_tunnel(
        &self,
        tunnel_id: &str,
    ) -> std::result::Result<(), CloudflareError> {
        self.delete(
            &format!(
                "/accounts/{}/cfd_tunnel/{tunnel_id}/connections",
                self.account_id
            ),
            "Cloudflare tunnel connection cleanup failed",
        )
        .await
    }

    async fn delete_dns_record(
        &self,
        dns_record_id: &str,
    ) -> std::result::Result<(), CloudflareError> {
        self.delete(
            &format!("/zones/{}/dns_records/{dns_record_id}", self.zone_id),
            "Cloudflare DNS route deletion failed",
        )
        .await
    }

    async fn delete_tunnel(
        &self,
        tunnel_id: &str,
    ) -> std::result::Result<(), CloudflareError> {
        self.delete(
            &format!("/accounts/{}/cfd_tunnel/{tunnel_id}", self.account_id),
            "Cloudflare tunnel deletion failed",
        )
        .await
    }

    async fn delete(
        &self,
        path: &str,
        context: &'static str,
    ) -> std::result::Result<(), CloudflareError> {
        let url = format!("{CLOUDFLARE_API_BASE}{path}");
        let response = self
            .client
            .delete(url)
            .bearer_auth(self.api_token.as_ref())
            .send()
            .await
            .map_err(|_| CloudflareError {
                status: None,
                context,
            })?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        if !response.status().is_success() {
            return Err(CloudflareError {
                status: StatusCode::from_u16(response.status().as_u16()).ok(),
                context,
            });
        }
        Ok(())
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        context: &'static str,
    ) -> std::result::Result<T, CloudflareError> {
        let url = format!("{CLOUDFLARE_API_BASE}{path}");
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(self.api_token.as_ref());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| CloudflareError {
            status: None,
            context,
        })?;
        if !response.status().is_success() {
            return Err(CloudflareError {
                status: StatusCode::from_u16(response.status().as_u16()).ok(),
                context,
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CLOUDFLARE_RESPONSE_BYTES as u64)
        {
            return Err(CloudflareError {
                status: None,
                context: "Cloudflare API response exceeded broker size limit",
            });
        }
        let bytes = response.bytes().await.map_err(|_| CloudflareError {
            status: None,
            context,
        })?;
        if bytes.len() > MAX_CLOUDFLARE_RESPONSE_BYTES {
            return Err(CloudflareError {
                status: None,
                context: "Cloudflare API response exceeded broker size limit",
            });
        }
        let envelope: CloudflareEnvelope<T> =
            serde_json::from_slice(&bytes).map_err(|_| CloudflareError {
                status: None,
                context: "Cloudflare API returned an invalid response",
            })?;
        if !envelope.success {
            return Err(CloudflareError {
                status: None,
                context,
            });
        }
        Ok(envelope.result)
    }
}

fn random_tunnel_secret() -> String {
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    STANDARD.encode(bytes)
}

fn valid_tunnel_token(token: &str) -> bool {
    (20..=16 * 1024).contains(&token.len())
        && token.is_ascii()
        && !token.contains(char::is_whitespace)
}

fn installation_hostname(subject: &str, installation_id: &str, suffix: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(subject.as_bytes());
    digest.update([0]);
    digest.update(installation_id.as_bytes());
    let opaque = hex::encode(digest.finalize());
    format!("{}.{}", &opaque[..24], suffix)
}

fn tunnel_name(subject: &str, installation_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"sourcenerve-desktop\0");
    digest.update(subject.as_bytes());
    digest.update([0]);
    digest.update(installation_id.as_bytes());
    let opaque = hex::encode(digest.finalize());
    format!("sourcenerve-desktop-{}", &opaque[..24])
}

fn validate_installation_id(value: &str) -> std::result::Result<(), Response> {
    if !(16..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(bad_request(
            "installationId must be 16-128 ASCII letters, numbers, '-' or '_'",
        ));
    }
    Ok(())
}

fn valid_metadata(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.is_ascii()
        && !value.chars().any(char::is_control)
}

fn validate_hostname_suffix(value: &str) -> anyhow::Result<()> {
    if value.len() > 220
        || value.starts_with('.')
        || value.ends_with('.')
        || value.split('.').count() < 2
        || value.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        bail!("SOURCENERVE_DESKTOP_HOSTNAME_SUFFIX must be a valid DNS suffix");
    }
    Ok(())
}

fn validate_cloudflare_id(name: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("{name} must be 1-64 ASCII letters, numbers, '-' or '_'");
    }
    Ok(())
}

fn required_env(name: &str) -> anyhow::Result<String> {
    let value = env::var(name)
        .with_context(|| format!("{name} is required when Desktop broker is enabled"))?;
    if value.trim().is_empty() {
        bail!("{name} must not be blank");
    }
    Ok(value)
}

fn env_bool(name: &str) -> anyhow::Result<bool> {
    let Ok(value) = env::var(name) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be one of true/false, 1/0, yes/no, or on/off"),
    }
}

fn bad_request(message: &'static str) -> Response {
    error_response(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn not_found() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "not_found",
        "Desktop installation was not found",
    )
}

fn internal_error() -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "Desktop broker operation failed",
    )
}

fn upstream_error() -> Response {
    error_response(
        StatusCode::BAD_GATEWAY,
        "upstream_error",
        "Cloudflare provisioning operation failed",
    )
}

fn error_response(status: StatusCode, error: &'static str, message: &'static str) -> Response {
    (status, Json(ErrorResponse { error, message })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_hostnames_are_deterministic_and_opaque() {
        let first = installation_hostname(
            "auth0|user-123",
            "install_1234567890",
            "mcp.example.test",
        );
        let second = installation_hostname(
            "auth0|user-123",
            "install_1234567890",
            "mcp.example.test",
        );
        assert_eq!(first, second);
        assert!(first.ends_with(".mcp.example.test"));
        assert!(!first.contains("user-123"));
        assert!(!first.contains("install_1234567890"));
    }

    #[test]
    fn installation_ids_are_strictly_bounded() {
        assert!(validate_installation_id("install_1234567890").is_ok());
        assert!(validate_installation_id("short").is_err());
        assert!(validate_installation_id("install/../../escape").is_err());
        assert!(validate_installation_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn tunnel_secret_has_at_least_256_bits_of_material() {
        let secret = random_tunnel_secret();
        let bytes = STANDARD.decode(secret).expect("base64 tunnel secret");
        assert_eq!(bytes.len(), 32);
    }

    #[test]
    fn hostname_suffix_validation_rejects_unsafe_values() {
        assert!(validate_hostname_suffix("mcp.example.test").is_ok());
        assert!(validate_hostname_suffix("localhost").is_err());
        assert!(validate_hostname_suffix("-bad.example.test").is_err());
        assert!(validate_hostname_suffix("bad_.example.test").is_err());
    }

    #[test]
    fn rate_limiter_blocks_excess_mutations() {
        let mut limiter = RateLimiter::default();
        for _ in 0..2 {
            assert!(limiter.allow("key".into(), 2, Duration::from_secs(60)));
        }
        assert!(!limiter.allow("key".into(), 2, Duration::from_secs(60)));
    }

    #[test]
    fn tunnel_tokens_reject_whitespace_and_short_values() {
        assert!(valid_tunnel_token(&"a".repeat(32)));
        assert!(!valid_tunnel_token("short"));
        assert!(!valid_tunnel_token("abcdefghijklmnopqrstuvwxyz token"));
    }

    #[test]
    fn authenticated_jwt_subject_parser_is_bounded() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"auth0|user-123"}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(
            verified_subject_from_authenticated_token(&token).as_deref(),
            Some("auth0|user-123")
        );
        assert!(verified_subject_from_authenticated_token("invalid").is_none());
    }
}
