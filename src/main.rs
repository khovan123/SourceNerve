mod config;
mod db;
mod error;
mod git;
mod github;
mod graph;
mod graph_semantics;
#[cfg(test)]
mod graph_semantics_integration_tests;
mod http;
mod index;
mod mcp;
mod memory;
mod service;
mod workflow;
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
    let registry = WorkspaceRegistry::build(&cfg.workspace)?;
    let pool = db::connect(&cfg.storage.state_dir).await?;
    db::register_workspaces(&pool, &registry).await?;

    let state = AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: cfg.github.token.clone().map(Arc::new),
    };
    let app = http::router(state, cfg.auth.bearer_token.clone());
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
