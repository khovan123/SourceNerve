use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::Serialize;

const MAX_ITEMS_PER_GROUP: usize = 24;
const MAX_PROOF_CANDIDATES: usize = 48;
const MAX_MANIFEST_DEPTH: usize = 2;

pub const PROOF_FOCUSED_TEST: &str = "focused-test";
pub const PROOF_INTEGRATION: &str = "integration";
pub const PROOF_E2E: &str = "e2e";
pub const PROOF_RECOVERY_REHEARSAL: &str = "recovery-rehearsal";
pub const PROOF_MEASUREMENT: &str = "measurement";

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessProofCandidate {
    pub proof_type: String,
    pub source: String,
    pub cwd: Option<String>,
    pub command: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
pub struct HarnessRepositoryContext {
    pub entrypoints: Vec<String>,
    pub guidance: Vec<String>,
    pub active_plans: Vec<String>,
    pub validation_owners: Vec<String>,
    pub proof_candidates: Vec<HarnessProofCandidate>,
    pub truncated: bool,
}

fn normalize_relative(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        ".".to_string()
    } else {
        value
    }
}

fn push_file(root: &Path, relative: &str, output: &mut Vec<String>, truncated: &mut bool) {
    if output.len() >= MAX_ITEMS_PER_GROUP {
        *truncated = true;
        return;
    }
    let path = root.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return;
    }
    if !output.iter().any(|value| value == relative) {
        output.push(relative.replace('\\', "/"));
    }
}

fn push_markdown_dir(
    root: &Path,
    relative_dir: &str,
    output: &mut Vec<String>,
    truncated: &mut bool,
) {
    let directory = root.join(relative_dir);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() || !file_type.is_file() {
                return None;
            }
            let name = entry.file_name().into_string().ok()?;
            if !name.to_ascii_lowercase().ends_with(".md") {
                return None;
            }
            Some(name)
        })
        .collect::<Vec<_>>();
    names.sort();
    for name in names {
        if output.len() >= MAX_ITEMS_PER_GROUP {
            *truncated = true;
            break;
        }
        output.push(format!("{relative_dir}/{name}"));
    }
}

fn workflow_files(root: &Path) -> Vec<String> {
    let relative_dir = ".github/workflows";
    let Ok(entries) = fs::read_dir(root.join(relative_dir)) else {
        return Vec::new();
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() || !file_type.is_file() {
                return None;
            }
            let name = entry.file_name().into_string().ok()?;
            let lower = name.to_ascii_lowercase();
            if !(lower.ends_with(".yml") || lower.ends_with(".yaml")) {
                return None;
            }
            Some(format!("{relative_dir}/{name}"))
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | "coverage" | ".next" | ".cache"
    )
}

fn discover_manifests(root: &Path) -> Vec<String> {
    const NAMES: &[&str] = &[
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "Makefile",
        "Taskfile.yml",
        "Taskfile.yaml",
        "Justfile",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
    ];

    let mut found = BTreeSet::new();
    let mut queue = vec![(PathBuf::new(), 0usize)];
    let mut visited = 0usize;
    while let Some((relative_dir, depth)) = queue.pop() {
        if visited >= 128 {
            break;
        }
        visited += 1;
        for name in NAMES {
            let relative = relative_dir.join(name);
            let absolute = root.join(&relative);
            let Ok(metadata) = fs::symlink_metadata(&absolute) else {
                continue;
            };
            if !metadata.file_type().is_symlink() && metadata.is_file() {
                found.insert(normalize_relative(&relative));
            }
        }
        if depth >= MAX_MANIFEST_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(root.join(&relative_dir)) else {
            continue;
        };
        let mut dirs = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if file_type.is_symlink() || !file_type.is_dir() {
                    return None;
                }
                let name = entry.file_name().into_string().ok()?;
                if should_skip_dir(&name) || name.starts_with('.') {
                    return None;
                }
                Some(name)
            })
            .collect::<Vec<_>>();
        dirs.sort_by(|a, b| b.cmp(a));
        for name in dirs {
            queue.push((relative_dir.join(name), depth + 1));
        }
    }
    found.into_iter().collect()
}

fn proof_type_for_text(name: &str, command: &str) -> Option<&'static str> {
    let combined = format!(
        "{} {}",
        name.to_ascii_lowercase(),
        command.to_ascii_lowercase()
    );
    if [
        "recovery",
        "rehearsal",
        "failover",
        "restore",
        "restart-safe",
        "resume-test",
    ]
    .iter()
    .any(|token| combined.contains(token))
    {
        return Some(PROOF_RECOVERY_REHEARSAL);
    }
    if ["e2e", "end-to-end", "playwright", "cypress", "webdriver"]
        .iter()
        .any(|token| combined.contains(token))
    {
        return Some(PROOF_E2E);
    }
    if [
        "integration",
        "contract-test",
        "contract:test",
        "component-test",
    ]
    .iter()
    .any(|token| combined.contains(token))
    {
        return Some(PROOF_INTEGRATION);
    }
    if [
        "benchmark",
        "bench",
        "performance",
        "perf",
        "load-test",
        "measure",
    ]
    .iter()
    .any(|token| combined.contains(token))
    {
        return Some(PROOF_MEASUREMENT);
    }
    let script_name = name.to_ascii_lowercase();
    if script_name == "test"
        || script_name.starts_with("test:")
        || combined.contains("vitest")
        || combined.contains("pytest")
        || combined.contains("cargo test")
        || combined.contains("go test")
    {
        return Some(PROOF_FOCUSED_TEST);
    }
    None
}

fn push_candidate(
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
    candidate: HarnessProofCandidate,
) {
    if output.iter().any(|existing| {
        existing.proof_type == candidate.proof_type
            && existing.cwd == candidate.cwd
            && existing.command == candidate.command
    }) {
        return;
    }
    if output.len() >= MAX_PROOF_CANDIDATES {
        *truncated = true;
        return;
    }
    output.push(candidate);
}

fn manifest_cwd(manifest: &str) -> Option<String> {
    let parent = Path::new(manifest).parent()?;
    let value = normalize_relative(parent);
    if value == "." { None } else { Some(value) }
}

fn inspect_package_json(
    root: &Path,
    manifest: &str,
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
) {
    let Ok(text) = fs::read_to_string(root.join(manifest)) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(scripts) = value.get("scripts").and_then(serde_json::Value::as_object) else {
        return;
    };
    let mut names = scripts.keys().cloned().collect::<Vec<_>>();
    names.sort();
    for name in names {
        let Some(command_body) = scripts.get(&name).and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(proof_type) = proof_type_for_text(&name, command_body) else {
            continue;
        };
        push_candidate(
            output,
            truncated,
            HarnessProofCandidate {
                proof_type: proof_type.to_string(),
                source: manifest.to_string(),
                cwd: manifest_cwd(manifest),
                command: format!("npm run {name}"),
                reason: format!("repository script `{name}` is declared by {manifest}"),
            },
        );
    }
}

fn rust_test_functions(
    root: &Path,
    relative: &Path,
    cwd: Option<String>,
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
) {
    let Ok(text) = fs::read_to_string(root.join(relative)) else {
        return;
    };
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some(fn_pos) = trimmed.find("fn ") else {
            continue;
        };
        let rest = &trimmed[fn_pos + 3..];
        let name = rest
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .next()
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let Some(proof_type) = proof_type_for_text(name, name) else {
            continue;
        };
        if proof_type != PROOF_RECOVERY_REHEARSAL {
            continue;
        }
        push_candidate(
            output,
            truncated,
            HarnessProofCandidate {
                proof_type: proof_type.to_string(),
                source: normalize_relative(relative),
                cwd: cwd.clone(),
                command: format!("cargo test {name}"),
                reason: format!(
                    "recovery-oriented Rust test `{name}` is present in {}",
                    normalize_relative(relative)
                ),
            },
        );
    }
}

fn inspect_cargo_manifest(
    root: &Path,
    manifest: &str,
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
) {
    let cwd = manifest_cwd(manifest);
    push_candidate(
        output,
        truncated,
        HarnessProofCandidate {
            proof_type: PROOF_FOCUSED_TEST.to_string(),
            source: manifest.to_string(),
            cwd: cwd.clone(),
            command: "cargo test <focused-target>".to_string(),
            reason: format!("Rust test harness is declared by {manifest}"),
        },
    );

    let manifest_dir = Path::new(manifest)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let tests_dir = root.join(manifest_dir).join("tests");
    if let Ok(entries) = fs::read_dir(&tests_dir) {
        let mut files = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if file_type.is_symlink() || !file_type.is_file() {
                    return None;
                }
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("rs") {
                    return None;
                }
                path.file_name()?.to_str().map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            let target = file.trim_end_matches(".rs");
            let relative = manifest_dir.join("tests").join(&file);
            push_candidate(
                output,
                truncated,
                HarnessProofCandidate {
                    proof_type: PROOF_INTEGRATION.to_string(),
                    source: normalize_relative(&relative),
                    cwd: cwd.clone(),
                    command: format!("cargo test --test {target}"),
                    reason: format!(
                        "integration test target `{target}` is present in the repository"
                    ),
                },
            );
            rust_test_functions(root, &relative, cwd.clone(), output, truncated);
        }
    }

    let src_dir = root.join(manifest_dir).join("src");
    if let Ok(entries) = fs::read_dir(&src_dir) {
        let mut files = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if file_type.is_symlink() || !file_type.is_file() {
                    return None;
                }
                let name = entry.file_name().into_string().ok()?;
                if !(name.ends_with("_integration_tests.rs") || name == "integration_tests.rs") {
                    return None;
                }
                Some(name)
            })
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            let stem = file.trim_end_matches(".rs");
            let relative = manifest_dir.join("src").join(&file);
            push_candidate(
                output,
                truncated,
                HarnessProofCandidate {
                    proof_type: PROOF_INTEGRATION.to_string(),
                    source: normalize_relative(&relative),
                    cwd: cwd.clone(),
                    command: format!("cargo test {stem}"),
                    reason: format!(
                        "integration test module `{stem}` is present in the repository"
                    ),
                },
            );
            rust_test_functions(root, &relative, cwd.clone(), output, truncated);
        }
    }
}

fn inspect_make_like(
    root: &Path,
    manifest: &str,
    runner: &str,
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
) {
    let Ok(text) = fs::read_to_string(root.join(manifest)) else {
        return;
    };
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((target, _)) = line.split_once(':') else {
            continue;
        };
        let target = target.trim();
        if target.is_empty() || target.contains(['=', ' ', '\t']) {
            continue;
        }
        let Some(proof_type) = proof_type_for_text(target, target) else {
            continue;
        };
        push_candidate(
            output,
            truncated,
            HarnessProofCandidate {
                proof_type: proof_type.to_string(),
                source: manifest.to_string(),
                cwd: manifest_cwd(manifest),
                command: format!("{runner} {target}"),
                reason: format!("validation target `{target}` is declared by {manifest}"),
            },
        );
    }
}

fn inspect_workflow(
    root: &Path,
    workflow: &str,
    output: &mut Vec<HarnessProofCandidate>,
    truncated: &mut bool,
) {
    let Ok(text) = fs::read_to_string(root.join(workflow)) else {
        return;
    };
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(command) = trimmed.strip_prefix("run:").map(str::trim) else {
            continue;
        };
        if command.is_empty() || command == "|" || command == ">" {
            continue;
        }
        let command = command.trim_matches(['\'', '"']);
        let Some(proof_type) = proof_type_for_text(command, command) else {
            continue;
        };
        push_candidate(
            output,
            truncated,
            HarnessProofCandidate {
                proof_type: proof_type.to_string(),
                source: workflow.to_string(),
                cwd: None,
                command: command.to_string(),
                reason: format!("CI validation command is declared by {workflow}"),
            },
        );
    }
}

pub fn preferred_proof_types(work_shape: &str) -> &'static [&'static str] {
    match work_shape {
        "bounded" => &[PROOF_FOCUSED_TEST, PROOF_INTEGRATION, PROOF_E2E],
        "durable" => &[
            PROOF_RECOVERY_REHEARSAL,
            PROOF_INTEGRATION,
            PROOF_FOCUSED_TEST,
        ],
        "operate-application" => &[PROOF_E2E, PROOF_INTEGRATION, PROOF_MEASUREMENT],
        "invariant" => &[
            PROOF_INTEGRATION,
            PROOF_RECOVERY_REHEARSAL,
            PROOF_FOCUSED_TEST,
        ],
        "read-only" => &[PROOF_MEASUREMENT],
        _ => &[],
    }
}

fn candidate_scope_score(candidate: &HarnessProofCandidate, work_scope: Option<&str>) -> i64 {
    let Some(work_scope) = work_scope else {
        return if candidate.cwd.is_none() { 1 } else { 0 };
    };
    let scope_segments = work_scope
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    let candidate_scope = candidate.cwd.as_deref().unwrap_or_else(|| {
        Path::new(&candidate.source)
            .parent()
            .and_then(Path::to_str)
            .unwrap_or("")
    });
    let candidate_segments = candidate_scope
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    let common = scope_segments
        .iter()
        .zip(candidate_segments.iter())
        .take_while(|(left, right)| left == right)
        .count() as i64;
    let root_bonus = if candidate.cwd.is_none() { 5 } else { 0 };
    common * 100 + root_bonus - candidate_segments.len() as i64
}

pub fn select_proof_candidate<'a>(
    work_shape: &str,
    context: &'a HarnessRepositoryContext,
    work_scope: Option<&str>,
) -> Option<&'a HarnessProofCandidate> {
    for proof_type in preferred_proof_types(work_shape) {
        if let Some(candidate) = context
            .proof_candidates
            .iter()
            .filter(|candidate| candidate.proof_type == *proof_type)
            .max_by_key(|candidate| candidate_scope_score(candidate, work_scope))
        {
            return Some(candidate);
        }
    }
    None
}

pub fn select_proof_type(work_shape: &str, context: &HarnessRepositoryContext) -> Option<String> {
    select_proof_candidate(work_shape, context, None)
        .map(|candidate| candidate.proof_type.clone())
        .or_else(|| {
            if work_shape == "read-only" {
                None
            } else {
                preferred_proof_types(work_shape)
                    .first()
                    .map(|value| (*value).to_string())
            }
        })
}

pub fn discover(root: &Path) -> HarnessRepositoryContext {
    let mut result = HarnessRepositoryContext::default();

    for path in ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md"] {
        push_file(root, path, &mut result.entrypoints, &mut result.truncated);
    }

    for path in [
        "docs/README.md",
        "docs/WORKFLOW.md",
        "docs/HARNESS.md",
        "docs/ARCHITECTURE.md",
        "tests/README.md",
    ] {
        push_file(root, path, &mut result.guidance, &mut result.truncated);
    }
    push_markdown_dir(
        root,
        "docs/product",
        &mut result.guidance,
        &mut result.truncated,
    );
    push_markdown_dir(
        root,
        "docs/decisions",
        &mut result.guidance,
        &mut result.truncated,
    );
    push_markdown_dir(
        root,
        "docs/plans/active",
        &mut result.active_plans,
        &mut result.truncated,
    );

    let manifests = discover_manifests(root);
    for manifest in &manifests {
        if result.validation_owners.len() >= MAX_ITEMS_PER_GROUP {
            result.truncated = true;
            break;
        }
        result.validation_owners.push(manifest.clone());
        if manifest.ends_with("package.json") {
            inspect_package_json(
                root,
                manifest,
                &mut result.proof_candidates,
                &mut result.truncated,
            );
        } else if manifest.ends_with("Cargo.toml") {
            inspect_cargo_manifest(
                root,
                manifest,
                &mut result.proof_candidates,
                &mut result.truncated,
            );
        } else if manifest.ends_with("Makefile") {
            inspect_make_like(
                root,
                manifest,
                "make",
                &mut result.proof_candidates,
                &mut result.truncated,
            );
        } else if manifest.ends_with("Justfile") {
            inspect_make_like(
                root,
                manifest,
                "just",
                &mut result.proof_candidates,
                &mut result.truncated,
            );
        }
    }

    let workflows = workflow_files(root);
    for workflow in workflows {
        if result.validation_owners.len() < MAX_ITEMS_PER_GROUP {
            result.validation_owners.push(workflow.clone());
        } else {
            result.truncated = true;
        }
        inspect_workflow(
            root,
            &workflow,
            &mut result.proof_candidates,
            &mut result.truncated,
        );
    }

    result.proof_candidates.sort_by(|a, b| {
        a.proof_type
            .cmp(&b.proof_type)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.command.cmp(&b.command))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_context_is_bounded_and_does_not_follow_symlinks() {
        let temp = tempfile::tempdir().expect("temp repository");
        fs::create_dir_all(temp.path().join("docs/plans/active")).expect("plans dir");
        fs::create_dir_all(temp.path().join("docs/product")).expect("product dir");
        fs::create_dir_all(temp.path().join("desktop")).expect("desktop dir");
        fs::write(temp.path().join("AGENTS.md"), "# agents\n").expect("agents");
        fs::write(temp.path().join("README.md"), "# repo\n").expect("readme");
        fs::write(temp.path().join("docs/product/policy.md"), "# policy\n").expect("policy");
        fs::write(temp.path().join("docs/plans/active/change.md"), "# plan\n").expect("plan");
        fs::write(temp.path().join("Cargo.toml"), "[package]\nname='demo'\n").expect("cargo");
        fs::write(
            temp.path().join("desktop/package.json"),
            r#"{"scripts":{"typecheck":"tsc --noEmit","test":"vitest run","test:integration":"vitest run -c integration.ts","test:e2e":"playwright test","bench":"node bench.mjs"}}"#,
        )
        .expect("package");

        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", temp.path().join("CLAUDE.md")).expect("symlink");

        let context = discover(temp.path());
        assert_eq!(context.entrypoints, vec!["AGENTS.md", "README.md"]);
        assert_eq!(context.guidance, vec!["docs/product/policy.md"]);
        assert_eq!(context.active_plans, vec!["docs/plans/active/change.md"]);
        assert!(
            context
                .validation_owners
                .contains(&"Cargo.toml".to_string())
        );
        assert!(
            context
                .validation_owners
                .contains(&"desktop/package.json".to_string())
        );
        assert!(
            !context
                .proof_candidates
                .iter()
                .any(|candidate| candidate.command.contains("typecheck"))
        );
        assert!(
            context
                .proof_candidates
                .iter()
                .any(|candidate| candidate.proof_type == PROOF_FOCUSED_TEST
                    && candidate.command == "npm run test")
        );
        assert!(
            context
                .proof_candidates
                .iter()
                .any(|candidate| candidate.proof_type == PROOF_INTEGRATION
                    && candidate.command == "npm run test:integration")
        );
        assert!(
            context
                .proof_candidates
                .iter()
                .any(|candidate| candidate.proof_type == PROOF_E2E
                    && candidate.command == "npm run test:e2e")
        );
        assert!(
            context
                .proof_candidates
                .iter()
                .any(|candidate| candidate.proof_type == PROOF_MEASUREMENT
                    && candidate.command == "npm run bench")
        );
        assert_eq!(
            select_proof_type("bounded", &context).as_deref(),
            Some(PROOF_FOCUSED_TEST)
        );
        assert_eq!(
            select_proof_type("operate-application", &context).as_deref(),
            Some(PROOF_E2E)
        );
        assert!(!context.truncated);
    }
}
