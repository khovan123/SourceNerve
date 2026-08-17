use std::{path::Path, process::Stdio};

use tokio::{io::AsyncWriteExt, process::Command};

use crate::error::{AppError, AppResult};

async fn output(root: &Path, args: &[&str]) -> AppResult<String> {
    let out = Command::new("git").current_dir(root).args(args).output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Command(if stderr.is_empty() { format!("git {:?} failed", args) } else { stderr }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub async fn head(root: &Path) -> AppResult<String> { output(root, &["rev-parse", "HEAD"]).await }
pub async fn status(root: &Path) -> AppResult<String> { output(root, &["status", "--porcelain=v1"]).await }
pub async fn diff(root: &Path) -> AppResult<String> { output(root, &["diff", "--no-ext-diff", "--"]).await }

async fn apply_internal(root: &Path, patch: &str, check: bool) -> AppResult<()> {
    let mut command = Command::new("git");
    command.current_dir(root).arg("apply");
    if check { command.arg("--check"); }
    command.arg("--whitespace=nowarn").arg("-")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).await?;
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::InvalidRequest(if stderr.is_empty() { "patch cannot be applied".into() } else { stderr }));
    }
    Ok(())
}

pub async fn check_patch(root: &Path, patch: &str) -> AppResult<()> { apply_internal(root, patch, true).await }
pub async fn apply_patch(root: &Path, patch: &str) -> AppResult<()> { apply_internal(root, patch, false).await }

pub fn patch_paths(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines().filter(|l| l.starts_with("+++ ")) {
        let raw = line.trim_start_matches("+++ ").split('\t').next().unwrap_or("");
        if raw == "/dev/null" { continue; }
        let p = raw.strip_prefix("b/").unwrap_or(raw);
        if !p.is_empty() && !paths.iter().any(|x| x == p) { paths.push(p.to_string()); }
    }
    paths
}
