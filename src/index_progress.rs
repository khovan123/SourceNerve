use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct IndexProgress {
    pub workspace: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub active: bool,
}

static PROGRESS: OnceLock<Mutex<HashMap<String, IndexProgress>>> = OnceLock::new();

fn store() -> &'static Mutex<HashMap<String, IndexProgress>> {
    PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_store<T>(callback: impl FnOnce(&mut HashMap<String, IndexProgress>) -> T) -> T {
    let mut guard = store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    callback(&mut guard)
}

pub fn begin(workspace: &str, total: usize) {
    with_store(|progress| {
        progress.insert(
            workspace.to_string(),
            IndexProgress {
                workspace: workspace.to_string(),
                stage: "syncing-files".to_string(),
                current: 0,
                total: total.max(1),
                active: true,
            },
        );
    });
}

#[allow(dead_code)]
pub fn advance(workspace: &str, stage: &str) {
    with_store(|progress| {
        let Some(progress) = progress.get_mut(workspace) else {
            return;
        };
        if !progress.active {
            return;
        }
        progress.current = progress.current.saturating_add(1).min(progress.total);
        progress.stage = stage.to_string();
    });
}

pub fn set(workspace: &str, stage: &str, current: usize, total: usize) {
    with_store(|progress| {
        let Some(progress) = progress.get_mut(workspace) else {
            return;
        };
        if !progress.active {
            return;
        }
        let total = total.max(1);
        progress.total = total;
        progress.current = current.min(total);
        progress.stage = stage.to_string();
    });
}

pub fn complete(workspace: &str) {
    with_store(|progress| {
        let Some(progress) = progress.get_mut(workspace) else {
            return;
        };
        progress.current = progress.total;
        progress.stage = "index-complete".to_string();
        progress.active = false;
    });
}

pub fn fail(workspace: &str) {
    with_store(|progress| {
        let Some(progress) = progress.get_mut(workspace) else {
            return;
        };
        progress.stage = "index-failed".to_string();
        progress.active = false;
    });
}

pub fn snapshot(workspace: &str) -> IndexProgress {
    with_store(|progress| {
        progress
            .get(workspace)
            .cloned()
            .unwrap_or_else(|| IndexProgress {
                workspace: workspace.to_string(),
                stage: "idle".to_string(),
                current: 0,
                total: 0,
                active: false,
            })
    })
}
