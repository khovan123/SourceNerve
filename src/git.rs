use std::{path::Path, process::Stdio};

use tokio::{io::AsyncWriteExt, process::Command};

use crate::error::{AppError, AppResult};

async fn output(root: &Path, args: &[&str]) -> AppResult<String> {
    let out = Command::new("git")
        .current_dir(root)
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

pub async fn head(root: &Path) -> AppResult<String> {
    output(root, &["rev-parse", "HEAD"]).await
}
pub async fn status(root: &Path) -> AppResult<String> {
    output(root, &["status", "--porcelain=v1"]).await
}
pub async fn diff(root: &Path) -> AppResult<String> {
    output(root, &["diff", "--no-ext-diff", "--"]).await
}

pub async fn working_files(root: &Path) -> AppResult<Vec<String>> {
    let out = Command::new("git")
        .current_dir(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Command(if stderr.is_empty() {
            "git ls-files failed".into()
        } else {
            stderr
        }));
    }
    let mut paths = Vec::new();
    for raw in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let path = std::str::from_utf8(raw)
            .map_err(|_| AppError::InvalidRequest("workspace contains a non-UTF-8 path".into()))?;
        paths.push(path.to_string());
    }
    Ok(paths)
}

async fn apply_internal(root: &Path, patch: &str, check: bool) -> AppResult<()> {
    let mut command = Command::new("git");
    command.current_dir(root).arg("apply");
    if check {
        command.arg("--check");
    }
    command
        .arg("--whitespace=nowarn")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).await?;
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::InvalidRequest(if stderr.is_empty() {
            "patch cannot be applied".into()
        } else {
            stderr
        }));
    }
    Ok(())
}

pub async fn check_patch(root: &Path, patch: &str) -> AppResult<()> {
    apply_internal(root, patch, true).await
}
pub async fn apply_patch(root: &Path, patch: &str) -> AppResult<()> {
    apply_internal(root, patch, false).await
}

fn header_path(line: &str, prefix: &str, side_prefix: &str) -> Option<String> {
    let raw = line.strip_prefix(prefix)?.split('\t').next().unwrap_or("");
    if raw == "/dev/null" || raw.is_empty() {
        return None;
    }
    Some(raw.strip_prefix(side_prefix).unwrap_or(raw).to_string())
}

fn push_unique(paths: &mut Vec<String>, path: Option<String>) {
    if let Some(path) = path {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
}

pub fn patch_paths(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        if line.starts_with("--- ") {
            push_unique(&mut paths, header_path(line, "--- ", "a/"));
        } else if line.starts_with("+++ ") {
            push_unique(&mut paths, header_path(line, "+++ ", "b/"));
        } else if let Some(path) = line.strip_prefix("rename from ") {
            push_unique(&mut paths, Some(path.to_string()));
        } else if let Some(path) = line.strip_prefix("rename to ") {
            push_unique(&mut paths, Some(path.to_string()));
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::patch_paths;

    #[test]
    fn extracts_unique_target_paths() {
        let patch = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-old\n+new\n";
        assert_eq!(patch_paths(patch), vec!["src/a.rs", "src/b.rs"]);
    }

    #[test]
    fn tracks_deleted_files_by_old_path() {
        let patch = "diff --git a/src/deleted.rs b/src/deleted.rs\ndeleted file mode 100644\n--- a/src/deleted.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
        assert_eq!(patch_paths(patch), vec!["src/deleted.rs"]);
    }

    #[test]
    fn supports_created_files() {
        let patch = "diff --git a/src/new.rs b/src/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.rs\n@@ -0,0 +1 @@\n+new\n";
        assert_eq!(patch_paths(patch), vec!["src/new.rs"]);
    }

    #[test]
    fn tracks_both_sides_of_rename() {
        let patch = "diff --git a/src/old.rs b/src/new.rs\nsimilarity index 100%\nrename from src/old.rs\nrename to src/new.rs\n";
        assert_eq!(patch_paths(patch), vec!["src/old.rs", "src/new.rs"]);
    }

    #[test]
    fn tracks_both_sides_of_renamed_edit() {
        let patch = "diff --git a/src/old.rs b/src/new.rs\nsimilarity index 80%\nrename from src/old.rs\nrename to src/new.rs\n--- a/src/old.rs\n+++ b/src/new.rs\n@@ -1 +1 @@\n-old\n+new\n";
        assert_eq!(patch_paths(patch), vec!["src/old.rs", "src/new.rs"]);
    }
}
