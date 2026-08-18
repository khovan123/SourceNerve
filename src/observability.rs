use std::{
    collections::BTreeMap,
    env,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    http::{HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const HISTOGRAM_BUCKETS: [f64; 12] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
];
const MAX_OTLP_BODY_BYTES: usize = 512 * 1024;
const MAX_OTLP_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_OTLP_HEADERS: usize = 16;
const OTLP_TIMEOUT_SECS: u64 = 12;

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub metrics_enabled: bool,
    pub metrics_public: bool,
    pub metrics_include_workspace: bool,
    pub otel_enabled: bool,
    otlp_endpoint: Option<String>,
    otlp_headers: Vec<(String, String)>,
}

#[derive(Clone)]
struct Runtime {
    config: RuntimeConfig,
    metrics: Arc<Metrics>,
    started: Instant,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct RequestTrace {
    trace_id: String,
    span_id: String,
    operation: &'static str,
    method: &'static str,
    start_unix_nanos: u128,
    started: Instant,
}

#[derive(Default)]
struct MetricsState {
    http_requests: BTreeMap<(String, String), u64>,
    http_duration: BTreeMap<String, Histogram>,
    operations: BTreeMap<(String, String, String, String), u64>,
    operation_duration: BTreeMap<(String, String), Histogram>,
    provider_calls: BTreeMap<(String, String, String), u64>,
    task_transitions: BTreeMap<(String, String), u64>,
    callback_deliveries: BTreeMap<String, u64>,
    coordination_leases: BTreeMap<String, u64>,
}

#[derive(Default)]
struct Metrics {
    state: Mutex<MetricsState>,
    active_requests: std::sync::atomic::AtomicI64,
    readiness: std::sync::atomic::AtomicI64,
}

#[derive(Debug, Clone)]
struct Histogram {
    buckets: [u64; HISTOGRAM_BUCKETS.len()],
    count: u64,
    sum: f64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: [0; HISTOGRAM_BUCKETS.len()],
            count: 0,
            sum: 0.0,
        }
    }
}

impl Histogram {
    fn observe(&mut self, seconds: f64) {
        let value = if seconds.is_finite() && seconds >= 0.0 {
            seconds
        } else {
            0.0
        };
        self.count = self.count.saturating_add(1);
        self.sum += value;
        for (index, bound) in HISTOGRAM_BUCKETS.iter().enumerate() {
            if value <= *bound {
                self.buckets[index] = self.buckets[index].saturating_add(1);
            }
        }
    }
}

struct TempBody(PathBuf);

impl Drop for TempBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl RuntimeConfig {
    pub fn from_env() -> AppResult<Self> {
        let metrics_enabled = env_bool("SOURCENERVE_METRICS_ENABLED")?;
        let metrics_public = env_bool("SOURCENERVE_METRICS_PUBLIC")?;
        let metrics_include_workspace = env_bool("SOURCENERVE_METRICS_INCLUDE_WORKSPACE")?;
        if metrics_public && !metrics_enabled {
            return Err(AppError::InvalidRequest(
                "SOURCENERVE_METRICS_PUBLIC requires SOURCENERVE_METRICS_ENABLED=true".into(),
            ));
        }

        let otel_enabled = env_bool("SOURCENERVE_OTEL_ENABLED")?;
        let otlp_endpoint = if otel_enabled {
            Some(resolve_otlp_endpoint()?)
        } else {
            None
        };
        let otlp_headers = if otel_enabled {
            parse_otlp_headers(env::var("OTEL_EXPORTER_OTLP_HEADERS").ok().as_deref())?
        } else {
            Vec::new()
        };

        Ok(Self {
            metrics_enabled,
            metrics_public,
            metrics_include_workspace,
            otel_enabled,
            otlp_endpoint,
            otlp_headers,
        })
    }
}

pub async fn preflight(config: &RuntimeConfig) -> AppResult<()> {
    if !config.otel_enabled {
        return Ok(());
    }
    let status = Command::new("curl")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| AppError::Command(format!("failed to execute curl: {error}")))?;
    if !status.success() {
        return Err(AppError::Command(
            "curl is required when OpenTelemetry export is enabled".into(),
        ));
    }
    Ok(())
}

pub fn install_runtime(config: RuntimeConfig) -> AppResult<()> {
    RUNTIME
        .set(Runtime {
            config,
            metrics: Arc::new(Metrics::default()),
            started: Instant::now(),
        })
        .map_err(|_| AppError::Internal(anyhow::anyhow!("observability runtime already installed")))
}

pub fn metrics_enabled() -> bool {
    RUNTIME
        .get()
        .is_some_and(|runtime| runtime.config.metrics_enabled)
}

pub fn metrics_public() -> bool {
    RUNTIME
        .get()
        .is_some_and(|runtime| runtime.config.metrics_public)
}

pub fn otel_enabled() -> bool {
    RUNTIME
        .get()
        .is_some_and(|runtime| runtime.config.otel_enabled)
}

fn env_bool(name: &str) -> AppResult<bool> {
    let Ok(value) = env::var(name) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(AppError::InvalidRequest(format!(
            "{name} must be one of true/false, 1/0, yes/no, or on/off"
        ))),
    }
}

fn resolve_otlp_endpoint() -> AppResult<String> {
    if let Ok(protocol) = env::var("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
        .or_else(|_| env::var("OTEL_EXPORTER_OTLP_PROTOCOL"))
    {
        if protocol != "http/json" {
            return Err(AppError::InvalidRequest(
                "SourceNerve OTLP tracing currently requires OTEL_EXPORTER_OTLP_PROTOCOL=http/json"
                    .into(),
            ));
        }
    }

    let endpoint = if let Ok(value) = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") {
        value
    } else if let Ok(base) = env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        format!("{}/v1/traces", base.trim_end_matches('/'))
    } else {
        return Err(AppError::InvalidRequest(
            "SOURCENERVE_OTEL_ENABLED=true requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT"
                .into(),
        ));
    };

    if endpoint.is_empty()
        || endpoint.len() > 2048
        || !endpoint.is_ascii()
        || endpoint.trim() != endpoint
        || endpoint.contains('@')
        || endpoint.contains('#')
        || endpoint.chars().any(char::is_whitespace)
    {
        return Err(AppError::InvalidRequest(
            "OTLP traces endpoint must be a bounded credential-free ASCII URL".into(),
        ));
    }
    if endpoint.starts_with("https://") {
        return Ok(endpoint);
    }
    let allow_loopback = env_bool("SOURCENERVE_OTEL_ALLOW_INSECURE_LOOPBACK")?;
    if allow_loopback && literal_loopback_http(&endpoint) {
        return Ok(endpoint);
    }
    Err(AppError::InvalidRequest(
        "OTLP traces endpoint must use HTTPS; literal http://127.0.0.1 is allowed only when SOURCENERVE_OTEL_ALLOW_INSECURE_LOOPBACK=true"
            .into(),
    ))
}

fn literal_loopback_http(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    !authority.is_empty() && authority.chars().all(|ch| ch.is_ascii_digit())
}

fn parse_otlp_headers(raw: Option<&str>) -> AppResult<Vec<(String, String)>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.len() > 8192 || !raw.is_ascii() {
        return Err(AppError::InvalidRequest(
            "OTEL_EXPORTER_OTLP_HEADERS must be bounded ASCII".into(),
        ));
    }
    let mut headers = Vec::new();
    for item in raw.split(',').filter(|item| !item.is_empty()) {
        let (name, value) = item.split_once('=').ok_or_else(|| {
            AppError::InvalidRequest(
                "OTEL_EXPORTER_OTLP_HEADERS must use comma-separated key=value pairs".into(),
            )
        })?;
        if headers.len() >= MAX_OTLP_HEADERS
            || name.is_empty()
            || name.len() > 128
            || value.len() > 1024
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
            || value.chars().any(|ch| ch.is_ascii_control())
        {
            return Err(AppError::InvalidRequest(
                "OTLP headers exceed bounded safe header policy".into(),
            ));
        }
        headers.push((name.to_string(), value.to_string()));
    }
    Ok(headers)
}

fn normalize_operation(value: &str) -> &'static str {
    match value {
        "health" => "health",
        "readiness" => "readiness",
        "metrics" => "metrics",
        "status" => "status",
        "index" => "index",
        "memory" => "memory",
        "graph" => "graph",
        "scip" => "scip",
        "semantic" => "semantic",
        "architecture" => "architecture",
        "context" => "context",
        "task_lifecycle" => "task_lifecycle",
        "job_webhook" => "job_webhook",
        "github_webhook" => "github_webhook",
        "callback" => "callback",
        "git_provider" => "git_provider",
        "embedding_provider" => "embedding_provider",
        "coordination" => "coordination",
        "state_backup" => "state_backup",
        "mcp" => "mcp",
        "api_other" => "api_other",
        _ => "other",
    }
}

fn normalize_result(value: &str) -> &'static str {
    match value {
        "success" => "success",
        "error" => "error",
        "conflict" => "conflict",
        "replay" => "replay",
        "timeout" => "timeout",
        "rejected" => "rejected",
        "not_found" => "not_found",
        "unauthorized" => "unauthorized",
        _ => "other",
    }
}

fn normalize_provider(value: Option<&str>) -> &'static str {
    match value.unwrap_or("none") {
        "github" => "github",
        "gitlab" => "gitlab",
        "openai" => "openai",
        "executable" => "executable",
        "external" => "external",
        "none" => "none",
        _ => "other",
    }
}

fn workspace_label(runtime: &Runtime, workspace: Option<&str>) -> String {
    if !runtime.config.metrics_include_workspace {
        return "redacted".into();
    }
    let Some(value) = workspace else {
        return "none".into();
    };
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return "other".into();
    }
    value.to_string()
}

pub fn observe_operation(
    operation: &str,
    result: &str,
    provider: Option<&str>,
    workspace: Option<&str>,
    duration: Duration,
) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !runtime.config.metrics_enabled {
        return;
    }
    let operation = normalize_operation(operation).to_string();
    let result = normalize_result(result).to_string();
    let provider = normalize_provider(provider).to_string();
    let workspace = workspace_label(runtime, workspace);
    let mut state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state
        .operations
        .entry((operation.clone(), result, provider.clone(), workspace))
        .or_default() += 1;
    state
        .operation_duration
        .entry((operation, provider))
        .or_default()
        .observe(duration.as_secs_f64());
}

pub fn observe_provider_call(kind: &str, provider: &str, result: &str, duration: Duration) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !runtime.config.metrics_enabled {
        return;
    }
    let kind = match kind {
        "embedding" => "embedding",
        "git" => "git",
        "scip" => "scip",
        _ => "other",
    };
    let provider = normalize_provider(Some(provider)).to_string();
    let result = normalize_result(result).to_string();
    let mut state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state
        .provider_calls
        .entry((kind.to_string(), provider, result))
        .or_default() += 1;
    drop(state);
    observe_operation(
        if kind == "embedding" {
            "embedding_provider"
        } else {
            "git_provider"
        },
        result.as_str(),
        Some(provider.as_str()),
        None,
        duration,
    );
}

pub fn observe_task_transition(phase: &str, provider: Option<&str>) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !runtime.config.metrics_enabled {
        return;
    }
    let phase = match phase {
        "snapshot" | "branched" | "patched" | "reviewed" | "committed" | "pushed" | "pr_open"
        | "merged" | "completed" => phase,
        _ => "other",
    };
    let provider = normalize_provider(provider).to_string();
    let mut state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state
        .task_transitions
        .entry((phase.to_string(), provider))
        .or_default() += 1;
}

pub fn observe_callback(result: &str) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !runtime.config.metrics_enabled {
        return;
    }
    let result = normalize_result(result).to_string();
    let mut state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state.callback_deliveries.entry(result).or_default() += 1;
}

pub fn observe_coordination(result: &str) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !runtime.config.metrics_enabled {
        return;
    }
    let result = normalize_result(result).to_string();
    let mut state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *state.coordination_leases.entry(result).or_default() += 1;
}

pub fn set_readiness(ready: bool) {
    if let Some(runtime) = RUNTIME.get() {
        runtime
            .metrics
            .readiness
            .store(i64::from(ready), std::sync::atomic::Ordering::Relaxed);
    }
}

fn route_operation(path: &str) -> &'static str {
    match path {
        "/healthz" => "health",
        "/metrics" | "/api/v1/metrics" => "metrics",
        "/api/v1/status" => "status",
        "/api/v1/readiness" => "readiness",
        "/api/v1/index" => "index",
        "/api/v1/state/backup" | "/api/v1/state/backup/validate" => "state_backup",
        "/webhooks/v1/jobs" => "job_webhook",
        "/webhooks/v1/github" => "github_webhook",
        "/mcp" => "mcp",
        _ if path.starts_with("/api/v1/memory/") => "memory",
        _ if path.starts_with("/api/v1/graph/") => "graph",
        _ if path.starts_with("/api/v1/scip/") => "scip",
        _ if path.starts_with("/api/v1/semantic/") => "semantic",
        _ if path.starts_with("/api/v1/architecture/") => "architecture",
        _ if path.starts_with("/api/v1/context/") => "context",
        _ if path.starts_with("/api/v1/tasks/") => "task_lifecycle",
        _ if path.starts_with("/api/v1/callback") => "callback",
        _ => "api_other",
    }
}

fn result_for_status(status: u16) -> &'static str {
    match status {
        200..=399 => "success",
        401 | 403 => "unauthorized",
        404 => "not_found",
        409 => "conflict",
        400..=499 => "rejected",
        500..=599 => "error",
        _ => "other",
    }
}

fn method_label(method: &axum::http::Method) -> &'static str {
    match *method {
        axum::http::Method::GET => "GET",
        axum::http::Method::POST => "POST",
        axum::http::Method::PUT => "PUT",
        axum::http::Method::DELETE => "DELETE",
        _ => "OTHER",
    }
}

pub async fn request_middleware(request: Request<Body>, next: Next) -> Response {
    let operation = route_operation(request.uri().path());
    let method = method_label(request.method());
    let trace = begin_request_trace(operation, method);
    let started = Instant::now();
    if let Some(runtime) = RUNTIME.get() {
        runtime
            .metrics
            .active_requests
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let mut response = next.run(request).await;
    let duration = started.elapsed();
    if let Some(runtime) = RUNTIME.get() {
        runtime
            .metrics
            .active_requests
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        if runtime.config.metrics_enabled {
            let result = result_for_status(response.status().as_u16());
            let mut state = runtime
                .metrics
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *state
                .http_requests
                .entry((operation.to_string(), result.to_string()))
                .or_default() += 1;
            state
                .http_duration
                .entry(operation.to_string())
                .or_default()
                .observe(duration.as_secs_f64());
        }
    }
    if let Some(trace) = trace {
        if let Ok(value) = HeaderValue::from_str(&trace.trace_id) {
            response
                .headers_mut()
                .insert("x-sourcenerve-trace-id", value);
        }
        finish_request_trace(trace, result_for_status(response.status().as_u16()));
    }
    response
}

fn begin_request_trace(operation: &'static str, method: &'static str) -> Option<RequestTrace> {
    if !otel_enabled() {
        return None;
    }
    Some(RequestTrace {
        trace_id: Uuid::new_v4().simple().to_string(),
        span_id: Uuid::new_v4().simple().to_string()[..16].to_string(),
        operation,
        method,
        start_unix_nanos: unix_nanos(),
        started: Instant::now(),
    })
}

fn finish_request_trace(trace: RequestTrace, result: &'static str) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    let Some(endpoint) = runtime.config.otlp_endpoint.clone() else {
        return;
    };
    let headers = runtime.config.otlp_headers.clone();
    let elapsed = trace.started.elapsed();
    let end_unix_nanos = trace.start_unix_nanos.saturating_add(elapsed.as_nanos());
    let payload = serde_json::json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key":"service.name","value":{"stringValue":"sourcenerve"}},
                    {"key":"service.version","value":{"stringValue":env!("CARGO_PKG_VERSION")}}
                ]
            },
            "scopeSpans": [{
                "scope": {"name":"sourcenerve.observability","version":env!("CARGO_PKG_VERSION")},
                "spans": [{
                    "traceId": trace.trace_id,
                    "spanId": trace.span_id,
                    "name": format!("http.{}", trace.operation),
                    "kind": 2,
                    "startTimeUnixNano": trace.start_unix_nanos.to_string(),
                    "endTimeUnixNano": end_unix_nanos.to_string(),
                    "attributes": [
                        {"key":"sourcenerve.operation","value":{"stringValue":trace.operation}},
                        {"key":"http.request.method","value":{"stringValue":trace.method}},
                        {"key":"sourcenerve.result_class","value":{"stringValue":result}}
                    ],
                    "status": {"code": if result == "success" { 1 } else { 2 }}
                }]
            }]
        }]
    });
    tokio::spawn(async move {
        if let Err(error) = export_otlp_json(&endpoint, &headers, &payload).await {
            tracing::warn!(error = %error, "OpenTelemetry trace export failed");
        }
    });
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

async fn write_otlp_body(payload: &serde_json::Value) -> AppResult<TempBody> {
    let bytes = serde_json::to_vec(payload).map_err(anyhow::Error::from)?;
    if bytes.len() > MAX_OTLP_BODY_BYTES {
        return Err(AppError::Command(
            "OTLP trace payload exceeded 512 KiB limit".into(),
        ));
    }
    let path = env::temp_dir().join(format!(".sourcenerve-otlp-request-{}.json", Uuid::new_v4()));
    tokio::fs::write(&path, bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(TempBody(path))
}

async fn export_otlp_json(
    endpoint: &str,
    headers: &[(String, String)],
    payload: &serde_json::Value,
) -> AppResult<()> {
    let body = write_otlp_body(payload).await?;
    let mut command = Command::new("curl");
    command
        .env_clear()
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .args([
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--connect-timeout",
            "3",
            "--max-time",
            "10",
            "--max-filesize",
        ])
        .arg(MAX_OTLP_RESPONSE_BYTES.to_string())
        .args([
            "--request",
            "POST",
            "--url",
            endpoint,
            "--header",
            "Content-Type: application/json",
            "--data-binary",
        ])
        .arg(format!("@{}", body.0.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if !headers.is_empty() {
        command.args(["--header", "@-"]);
    }
    let mut child = command
        .spawn()
        .map_err(|error| AppError::Command(format!("failed to execute OTLP curl: {error}")))?;
    if !headers.is_empty() {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("failed to open OTLP curl stdin")))?;
        for (name, value) in headers {
            stdin
                .write_all(format!("{name}: {value}\n").as_bytes())
                .await?;
        }
        drop(stdin);
    }
    let status = timeout(Duration::from_secs(OTLP_TIMEOUT_SECS), child.wait())
        .await
        .map_err(|_| AppError::Command("OTLP trace export timed out".into()))?
        .map_err(|error| AppError::Command(format!("OTLP trace export failed: {error}")))?;
    if !status.success() {
        return Err(AppError::Command(format!(
            "OTLP trace export failed with curl status {status}"
        )));
    }
    Ok(())
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn render_histogram(
    output: &mut String,
    name: &str,
    labels: &[(&str, &str)],
    histogram: &Histogram,
) {
    let base_labels = labels
        .iter()
        .map(|(key, value)| format!("{key}=\"{}\"", escape_label(value)))
        .collect::<Vec<_>>();
    for (index, bound) in HISTOGRAM_BUCKETS.iter().enumerate() {
        let mut all = base_labels.clone();
        all.push(format!("le=\"{bound}\""));
        output.push_str(&format!(
            "{name}_bucket{{{}}} {}\n",
            all.join(","),
            histogram.buckets[index]
        ));
    }
    let mut all = base_labels.clone();
    all.push("le=\"+Inf\"".into());
    output.push_str(&format!(
        "{name}_bucket{{{}}} {}\n",
        all.join(","),
        histogram.count
    ));
    let labels = base_labels.join(",");
    output.push_str(&format!("{name}_sum{{{labels}}} {}\n", histogram.sum));
    output.push_str(&format!("{name}_count{{{labels}}} {}\n", histogram.count));
}

pub fn render_metrics() -> AppResult<String> {
    let runtime = RUNTIME.get().ok_or_else(|| {
        AppError::InvalidRequest("observability runtime is not configured".into())
    })?;
    if !runtime.config.metrics_enabled {
        return Err(AppError::InvalidRequest(
            "Prometheus metrics are disabled".into(),
        ));
    }
    let state = runtime
        .metrics
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut output = String::new();
    output.push_str("# HELP sourcenerve_build_info SourceNerve build information.\n");
    output.push_str("# TYPE sourcenerve_build_info gauge\n");
    output.push_str(&format!(
        "sourcenerve_build_info{{version=\"{}\"}} 1\n",
        env!("CARGO_PKG_VERSION")
    ));
    output.push_str("# HELP sourcenerve_process_uptime_seconds Process uptime in seconds.\n");
    output.push_str("# TYPE sourcenerve_process_uptime_seconds gauge\n");
    output.push_str(&format!(
        "sourcenerve_process_uptime_seconds {}\n",
        runtime.started.elapsed().as_secs_f64()
    ));
    output.push_str("# HELP sourcenerve_http_active_requests Active HTTP requests.\n");
    output.push_str("# TYPE sourcenerve_http_active_requests gauge\n");
    output.push_str(&format!(
        "sourcenerve_http_active_requests {}\n",
        runtime
            .metrics
            .active_requests
            .load(std::sync::atomic::Ordering::Relaxed)
    ));
    output.push_str("# HELP sourcenerve_readiness Ready state from the latest readiness probe.\n");
    output.push_str("# TYPE sourcenerve_readiness gauge\n");
    output.push_str(&format!(
        "sourcenerve_readiness {}\n",
        runtime
            .metrics
            .readiness
            .load(std::sync::atomic::Ordering::Relaxed)
    ));

    output.push_str("# HELP sourcenerve_http_requests_total HTTP requests by bounded operation and result class.\n");
    output.push_str("# TYPE sourcenerve_http_requests_total counter\n");
    for ((operation, result), count) in &state.http_requests {
        output.push_str(&format!(
            "sourcenerve_http_requests_total{{operation=\"{}\",result=\"{}\"}} {}\n",
            escape_label(operation),
            escape_label(result),
            count
        ));
    }
    output.push_str("# HELP sourcenerve_http_request_duration_seconds HTTP request latency by bounded operation.\n");
    output.push_str("# TYPE sourcenerve_http_request_duration_seconds histogram\n");
    for (operation, histogram) in &state.http_duration {
        render_histogram(
            &mut output,
            "sourcenerve_http_request_duration_seconds",
            &[("operation", operation)],
            histogram,
        );
    }

    output.push_str("# HELP sourcenerve_operations_total Internal bounded operations.\n");
    output.push_str("# TYPE sourcenerve_operations_total counter\n");
    for ((operation, result, provider, workspace), count) in &state.operations {
        output.push_str(&format!(
            "sourcenerve_operations_total{{operation=\"{}\",result=\"{}\",provider=\"{}\",workspace=\"{}\"}} {}\n",
            escape_label(operation), escape_label(result), escape_label(provider), escape_label(workspace), count
        ));
    }
    output.push_str("# HELP sourcenerve_operation_duration_seconds Internal operation latency.\n");
    output.push_str("# TYPE sourcenerve_operation_duration_seconds histogram\n");
    for ((operation, provider), histogram) in &state.operation_duration {
        render_histogram(
            &mut output,
            "sourcenerve_operation_duration_seconds",
            &[("operation", operation), ("provider", provider)],
            histogram,
        );
    }

    output.push_str("# HELP sourcenerve_provider_calls_total External provider calls.\n");
    output.push_str("# TYPE sourcenerve_provider_calls_total counter\n");
    for ((kind, provider, result), count) in &state.provider_calls {
        output.push_str(&format!(
            "sourcenerve_provider_calls_total{{kind=\"{}\",provider=\"{}\",result=\"{}\"}} {}\n",
            escape_label(kind),
            escape_label(provider),
            escape_label(result),
            count
        ));
    }
    output.push_str(
        "# HELP sourcenerve_task_transitions_total Durable task lifecycle transitions.\n",
    );
    output.push_str("# TYPE sourcenerve_task_transitions_total counter\n");
    for ((phase, provider), count) in &state.task_transitions {
        output.push_str(&format!(
            "sourcenerve_task_transitions_total{{phase=\"{}\",provider=\"{}\"}} {}\n",
            escape_label(phase),
            escape_label(provider),
            count
        ));
    }
    output.push_str("# HELP sourcenerve_callback_deliveries_total Callback delivery outcomes.\n");
    output.push_str("# TYPE sourcenerve_callback_deliveries_total counter\n");
    for (result, count) in &state.callback_deliveries {
        output.push_str(&format!(
            "sourcenerve_callback_deliveries_total{{result=\"{}\"}} {}\n",
            escape_label(result),
            count
        ));
    }
    output.push_str("# HELP sourcenerve_coordination_leases_total Coordination lease outcomes.\n");
    output.push_str("# TYPE sourcenerve_coordination_leases_total counter\n");
    for (result, count) in &state.coordination_leases {
        output.push_str(&format!(
            "sourcenerve_coordination_leases_total{{result=\"{}\"}} {}\n",
            escape_label(result),
            count
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{
        literal_loopback_http, normalize_operation, normalize_provider, normalize_result,
        parse_otlp_headers, route_operation,
    };

    #[test]
    fn low_cardinality_labels_fail_to_other() {
        assert_eq!(normalize_operation("/private/path.rs"), "other");
        assert_eq!(normalize_result("secret-error-body"), "other");
        assert_eq!(
            normalize_provider(Some("customer-private-provider")),
            "other"
        );
    }

    #[test]
    fn routes_never_use_source_paths_as_labels() {
        assert_eq!(route_operation("/api/v1/semantic/search"), "semantic");
        assert_eq!(route_operation("/api/v1/graph/status"), "graph");
        assert_eq!(route_operation("/api/v1/read"), "api_other");
        assert_eq!(route_operation("/api/v1/read/private/file.rs"), "api_other");
    }

    #[test]
    fn otlp_loopback_override_is_literal() {
        assert!(literal_loopback_http("http://127.0.0.1:4318/v1/traces"));
        assert!(!literal_loopback_http("http://localhost:4318/v1/traces"));
        assert!(!literal_loopback_http("https://127.0.0.1:4318/v1/traces"));
    }

    #[test]
    fn otlp_headers_are_bounded() {
        let headers = parse_otlp_headers(Some("api-key=secret,tenant=ci")).expect("headers");
        assert_eq!(headers.len(), 2);
        assert!(parse_otlp_headers(Some("bad header=value")).is_err());
        assert!(parse_otlp_headers(Some("missing-equals")).is_err());
    }
}
