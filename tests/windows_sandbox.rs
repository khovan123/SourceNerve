#![cfg(target_os = "windows")]

use std::{path::Path, process::Command};

const INTERNAL_HELPER_ARGUMENT: &str = "--internal-windows-sandbox";
const WORKSPACE_WRITE_CAPABILITY_SID: &str = "S-1-5-21-3827675621-2387804058-1153500159-2751659043";

fn grant_workspace_capability(path: &Path) {
    // `icacls` resolves trustees through the account database and rejects SourceNerve's
    // intentionally-unmapped synthetic restricting SID. .NET ACL APIs accept a raw SID and
    // exercise the same Windows DACL semantics without requiring a local account mapping.
    let script = r#"
$ErrorActionPreference = 'Stop'
$path = $env:SOURCENERVE_TEST_ACL_PATH
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:SOURCENERVE_TEST_ACL_SID)
$acl = Get-Acl -LiteralPath $path
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::Modify,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("SOURCENERVE_TEST_ACL_PATH", path)
        .env("SOURCENERVE_TEST_ACL_SID", WORKSPACE_WRITE_CAPABILITY_SID)
        .output()
        .expect("run PowerShell ACL setup for sandbox fixture");
    assert!(
        output.status.success(),
        "PowerShell ACL setup failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_helper(mode: &str, cwd: &Path, command: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_sourcenerve"))
        .arg(INTERNAL_HELPER_ARGUMENT)
        .arg(mode)
        .arg(cwd)
        .arg("cmd.exe")
        .arg("--")
        .args(["/D", "/S", "/C", command])
        .output()
        .expect("run SourceNerve Windows sandbox helper")
}

#[test]
fn restricted_token_enforces_read_only_and_workspace_write_boundaries() {
    let root = tempfile::tempdir().expect("create sandbox fixture root");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("create sandbox fixture workspace");
    grant_workspace_capability(&workspace);

    let read_only = run_helper("read-only", &workspace, "echo denied>read-only.txt");
    assert!(
        !read_only.status.success(),
        "read-only sandbox unexpectedly wrote into workspace"
    );
    assert!(!workspace.join("read-only.txt").exists());

    let workspace_write = run_helper(
        "workspace-write",
        &workspace,
        "echo allowed>workspace-write.txt",
    );
    assert!(
        workspace_write.status.success(),
        "workspace-write sandbox failed: stdout={} stderr={}",
        String::from_utf8_lossy(&workspace_write.stdout),
        String::from_utf8_lossy(&workspace_write.stderr)
    );
    assert!(workspace.join("workspace-write.txt").exists());

    let outside = root.path().join("outside.txt");
    let outside_command = format!("echo blocked>\"{}\"", outside.display());
    let outside_write = run_helper("workspace-write", &workspace, &outside_command);
    assert!(
        !outside_write.status.success(),
        "workspace-write sandbox unexpectedly wrote outside workspace"
    );
    assert!(!outside.exists());
}
