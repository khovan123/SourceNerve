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
mod error;
#[path = "git.rs"]
mod git_base;
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
mod mcp;
mod memory;
mod ops;
mod runtime;
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
    let embedding_runtime = embedding_provider::RuntimeConfig::from_env()?;
    runtime::preflight(&cfg).await?;
    embedding_provider::preflight(embedding_runtime.as_ref()).await?;
    embedding_provider::install_runtime(embedding_runtime)?;
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
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
