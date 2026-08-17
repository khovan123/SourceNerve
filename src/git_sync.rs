use std::path::Path;

use tokio::process::Command;

use crate::error::{AppError, AppResult};

async fn output(root: &Path, args: &[&str]) -> AppResult<String> {
    let out = Command::new("git")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Command(if stderr.is_empty() {
            format!("git {args:?} failed")
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub async fn sync_default(root: &Path, remote: &str, default_branch: &str) -> AppResult<String> {
    crate::git_base::validate_branch_name(root, default_branch).await?;
    output(root, &["fetch", remote, default_branch]).await?;
    output(root, &["switch", default_branch]).await?;
    let remote_ref = format!("{remote}/{default_branch}");
    output(root, &["merge", "--ff-only", &remote_ref]).await?;
    crate::git_base::head(root).await
}
