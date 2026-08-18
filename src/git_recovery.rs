use std::path::Path;

use tokio::process::Command;

use crate::error::{AppError, AppResult};

async fn output(root: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Command(if stderr.is_empty() {
            format!("git {args:?} failed")
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Return the single first parent of `commit`, or None for a root commit.
pub async fn first_parent(root: &Path, commit: &str) -> AppResult<Option<String>> {
    let line = output(root, &["rev-list", "--parents", "-n", "1", commit]).await?;
    let mut parts = line.split_whitespace();
    let _commit = parts.next();
    Ok(parts.next().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::first_parent;

    fn git(root: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("run git");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[tokio::test]
    async fn returns_parent_for_non_root_commit() {
        let repo = tempfile::tempdir().expect("repo");
        git(repo.path(), &["init", "-b", "main"]);
        git(repo.path(), &["config", "user.name", "SourceNerve Test"]);
        git(repo.path(), &["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.path().join("a.txt"), "one\n").expect("write one");
        git(repo.path(), &["add", "a.txt"]);
        git(repo.path(), &["commit", "-m", "one"]);
        let first = crate::git::head(repo.path()).await.expect("first head");
        std::fs::write(repo.path().join("a.txt"), "two\n").expect("write two");
        git(repo.path(), &["add", "a.txt"]);
        git(repo.path(), &["commit", "-m", "two"]);
        let second = crate::git::head(repo.path()).await.expect("second head");
        assert_eq!(first_parent(repo.path(), &second).await.unwrap(), Some(first));
    }
}
