mod architecture;
mod architecture_context;
mod architecture_http;
#[cfg(test)]
mod architecture_integration_tests;
mod callback;
mod callback_http;
#[cfg(test)]
mod callback_integration_tests;
mod config;
mod context;
mod context_http;
#[cfg(test)]
mod context_integration_tests;
mod coordination;
#[cfg(test)]
mod coordination_integration_tests;
mod db;
mod embedding_provider;
mod embedding_registry;
mod error;
#[path = "git.rs"]
mod git_base;
mod git_provider;
mod git_recovery;
mod git_sync;
mod git {
    pub use crate::git_base::*;
    pub use crate::git_sync::sync_default;
}
mod github;
mod github_webhook;
mod github_webhook_http;
#[cfg(test)]
mod github_webhook_integration_tests;
mod gitlab;
mod graph;
#[cfg(test)]
mod graph_baseline_acceptance_tests;
mod graph_reference_scope;
mod graph_semantics;
#[cfg(test)]
mod graph_semantics_integration_tests;
mod http;
mod index;
mod job_http;
mod job_ingress;
#[cfg(test)]
mod job_ingress_integration_tests;
#[path = "mcp_plugin.rs"]
mod mcp;
#[path = "mcp.rs"]
mod mcp_core;
mod memory;
mod oauth;
mod oauth_http;
mod observability;
mod observability_http;
mod ops;
mod runtime;
mod scip_analyzer;
mod scip_enrichment;
#[cfg(test)]
mod scip_enrichment_integration_tests;
mod scip_http;
mod semantic;
mod semantic_ann;
mod semantic_context;
mod semantic_http;
#[cfg(test)]
mod semantic_integration_tests;
mod service;
mod state_backup;
mod task_http;
mod task_lifecycle;
#[cfg(test)]
mod task_lifecycle_integration_tests;
mod task_transactions;
#[cfg(test)]
mod task_transactions_integration_tests;
mod workflow;
mod workflow_http;
#[cfg(test)]
mod workflow_integration_tests;
mod workspace;

use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use tokio::sync::Mutex;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{config::Config, service::AppState, workspace::WorkspaceRegistry};

#[cfg(unix)]
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::warn!(error = %error, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sourcenerve=info".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    let cfg = Config::load().await?;
    let observability_runtime = observability::RuntimeConfig::from_env()?;
    let embedding_runtime = embedding_provider::RuntimeConfig::from_env()?;
    let embedding_registry_runtime =
        embedding_registry::RuntimeConfig::from_env(embedding_runtime.is_some())?;
    let gitlab_runtime = gitlab::RuntimeConfig::from_env()?;
    let scip_analyzer_runtime = scip_analyzer::RuntimeConfig::from_env()?;
    runtime::preflight(&cfg).await?;
    observability::preflight(&observability_runtime).await?;
    embedding_provider::preflight(embedding_runtime.as_ref()).await?;
    embedding_registry::preflight(embedding_registry_runtime.as_ref()).await?;
    gitlab::preflight(gitlab_runtime.as_ref()).await?;
    scip_analyzer::preflight(scip_analyzer_runtime.as_ref()).await?;
    let oauth_runtime = oauth::Runtime::from_config(&cfg).await?;
    observability::install_runtime(observability_runtime)?;
    embedding_provider::install_runtime(embedding_runtime)?;
    embedding_registry::install_runtime(embedding_registry_runtime)?;
    gitlab::install_runtime(gitlab_runtime)?;
    scip_analyzer::install_runtime(scip_analyzer_runtime)?;
    let callback_runtime = callback::RuntimeConfig::from_config(&cfg)?;
    let registry = WorkspaceRegistry::build(&cfg.workspace)?;
    let pool = db::connect(&cfg.storage.state_dir).await?;
    db::register_workspaces(&pool, &registry).await?;

    let state = AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: cfg.github.token.clone().map(Arc::new),
    };
    callback::configure_runtime(&state, callback_runtime.is_some()).await?;
    if let Some(callback_runtime) = callback_runtime.clone() {
        tokio::spawn(callback::run_worker(state.clone(), callback_runtime));
    }

    let app = http::router(
        state,
        cfg.auth.bearer_token.clone(),
        oauth_runtime,
        cfg.webhook_secret.clone(),
        cfg.github_webhook_secret.clone(),
        callback_runtime.is_some(),
    );
    let addr: SocketAddr = cfg
        .server
        .bind
        .parse()
        .context("invalid server.bind socket address")?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "SourceNerve listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}
