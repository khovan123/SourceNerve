from pathlib import Path
import re


def sub_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}: {pattern[:160]!r}")
    file.write_text(updated)


def insert_before(path: str, marker: str, insertion: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(marker)
    if count != 1:
        raise SystemExit(f"{path}: expected one marker, found {count}: {marker!r}")
    file.write_text(text.replace(marker, insertion + marker, 1))


mcp = "src/mcp_process_plugin.rs"
sub_once(
    mcp,
    r'(        capability::HarnessCapabilitiesRequest,\n    \},\n)(    mcp_base::SourceNerveMcp as BaseSourceNerveMcp,)',
    r'\1    job_ingress::harness_job::{self, HarnessJobCallRequest},\n\2',
)
sub_once(
    mcp,
    r'const HARNESS_RUN_CANCEL_TOOL: &str = "harness_run_cancel";\n',
    'const HARNESS_RUN_CANCEL_TOOL: &str = "harness_run_cancel";\nconst HARNESS_JOB_CALL_TOOL: &str = "harness_job_call";\n',
)
sub_once(
    mcp,
    r'(\| HARNESS_RUN_CANCEL_TOOL\n)(\s*\| HARNESS_CAPABILITIES_TOOL)',
    r'\1                | HARNESS_JOB_CALL_TOOL\n\2',
)
insert_before(
    mcp,
    '\n                HARNESS_APPROVAL_RESPOND_TOOL => {',
    '''
                HARNESS_JOB_CALL_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessJobCallRequest>(
                        &request,
                        HARNESS_JOB_CALL_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness_job::call(&self.state, arguments, &principal_id, operator).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness job call failed: {error}"
                        ))),
                    }
                }
''',
)
insert_before(
    mcp,
    '\n        HARNESS_APPROVAL_RESPOND_TOOL => (',
    '''
        HARNESS_JOB_CALL_TOOL => (
            "Harness Job Call",
            "Start, inspect, wait for, or cancel one durable task-backed job bound to an owned Harness run. start is idempotent by client_request_id; wait is bounded and never cancels work on timeout; get/wait/cancel enforce exact run and principal ownership.",
            serde_json::json!({
                "type": "object",
                "required": ["run_id", "operation"],
                "properties": {
                    "run_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "operation": { "type": "string", "enum": ["start", "get", "wait", "cancel"] },
                    "job_id": { "type": ["string", "null"], "minLength": 1, "maxLength": 64, "default": null },
                    "client_request_id": { "type": ["string", "null"], "maxLength": 96, "default": null },
                    "context_query": { "type": ["string", "null"], "maxLength": 16384, "default": null },
                    "context_max_bytes": { "type": ["integer", "null"], "minimum": 1, "default": null },
                    "context_max_items": { "type": ["integer", "null"], "minimum": 1, "default": null },
                    "wait_timeout_ms": { "type": ["integer", "null"], "minimum": 0, "maximum": 30000, "default": null }
                },
                "additionalProperties": false
            }),
            false,
            true,
            true,
        ),
''',
)
sub_once(
    mcp,
    r'(\n\s*HARNESS_RUN_CANCEL_TOOL,\n)(\s*HARNESS_CAPABILITIES_TOOL,)',
    r'\1        HARNESS_JOB_CALL_TOOL,\n\2',
)
sub_once(
    mcp,
    r'(\n\s*let capabilities =\n\s*with_harness_context\(harness_tool\(HARNESS_CAPABILITIES_TOOL\)\.expect\("capabilities"\)\);)',
    r'\n        let jobs = with_harness_context(harness_tool(HARNESS_JOB_CALL_TOOL).expect("jobs"));\1',
)
sub_once(
    mcp,
    r'(        assert_eq!\(events\.input_schema\["properties"\]\["limit"\]\["maximum"\], 200\);\n)',
    r'''\1        assert_eq!(
            jobs.input_schema["properties"]["operation"]["enum"],
            serde_json::json!(["start", "get", "wait", "cancel"])
        );
        assert_eq!(
            jobs.input_schema["properties"]["wait_timeout_ms"]["maximum"],
            30000
        );
''',
)

pipeline = "src/harness_tool_pipeline.rs"
sub_once(
    pipeline,
    r'(        "mcp_extension_call_write" => safety\(false, true, false, true\),\n)',
    r'\1        "harness_job_call" => safety(false, true, true, false),\n',
)
sub_once(
    pipeline,
    r'fn request_run_id\(request: &CallToolRequestParams\) -> Option<String> \{.*?\n\}\n\nfn sandbox_rank',
    '''fn request_run_id(request: &CallToolRequestParams) -> Option<String> {
    let arguments = request.arguments.as_ref()?;
    let field = if request.name.as_ref() == "harness_job_call" {
        "run_id"
    } else {
        "_harness_run_id"
    };
    arguments
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sandbox_rank''',
    re.S,
)
sub_once(
    pipeline,
    r'("job_get"\n\s*\| "workspace_index")',
    '"job_get"\n        | "harness_job_call"\n        | "workspace_index"',
)
sub_once(
    pipeline,
    r'async fn load_run_binding\(\n\s*state: &AppState,\n\s*principal: &Principal,\n\s*run_id: &str,\n\) -> AppResult<RunBinding> \{',
    '''async fn load_run_binding(
    state: &AppState,
    principal: &Principal,
    run_id: &str,
    require_current_running: bool,
) -> AppResult<RunBinding> {''',
)
sub_once(
    pipeline,
    r'    if snapshot\.run\.status != "running" \|\| snapshot\.freshness\.state != "current" \{\n        return Err\(AppError::InvalidRequest\(format!\(\n            "harness run \{run_id\} is not current and running"\n        \)\)\);\n    \}',
    '''    if require_current_running
        && (snapshot.run.status != "running" || snapshot.freshness.state != "current")
    {
        return Err(AppError::InvalidRequest(format!(
            "harness run {run_id} is not current and running"
        )));
    }''',
)
sub_once(
    pipeline,
    r'    let requires_workspace_write = !safety\.read_only\n        && !matches!\(\n            request\.name\.as_ref\(\),\n            "harness_run_begin" \| "harness_run_cancel" \| "harness_approval_respond"\n        \);',
    '''    let harness_job_operation = if request.name.as_ref() == "harness_job_call" {
        request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("operation"))
            .and_then(serde_json::Value::as_str)
    } else {
        None
    };
    let requires_workspace_write = if request.name.as_ref() == "harness_job_call" {
        matches!(harness_job_operation, Some("start" | "cancel"))
    } else {
        !safety.read_only
            && !matches!(
                request.name.as_ref(),
                "harness_run_begin" | "harness_run_cancel" | "harness_approval_respond"
            )
    };''',
)
sub_once(
    pipeline,
    r'        let run = load_run_binding\(state, principal, run_id\)\.await\?;',
    '''        let require_current_running = request.name.as_ref() != "harness_job_call"
            || harness_job_operation == Some("start");
        let run = load_run_binding(state, principal, run_id, require_current_running).await?;''',
)
insert_before(
    pipeline,
    '    #[test]\n    fn unknown_tools_are_conservative_and_not_explicitly_classified() {',
    '''    #[test]
    fn harness_job_call_uses_domain_run_binding_and_core_jobs_policy() {
        let mut request = CallToolRequestParams::new("harness_job_call".to_string());
        request.arguments = Some(serde_json::Map::from_iter([
            (
                "run_id".to_string(),
                serde_json::Value::String("run-1".to_string()),
            ),
            (
                "operation".to_string(),
                serde_json::Value::String("get".to_string()),
            ),
        ]));
        assert_eq!(request_run_id(&request).as_deref(), Some("run-1"));
        assert_eq!(static_capability_id("harness_job_call"), Some("core.jobs"));
        assert_eq!(
            explicit_tool_safety("harness_job_call"),
            Some(safety(false, true, true, false))
        );
    }

''',
)

harness_job = "src/harness_job.rs"
insert_before(
    harness_job,
    '    #[tokio::test]\n    async fn wait_timeout_does_not_cancel_and_cancel_emits_terminal_once() {',
    '''    #[tokio::test]
    async fn harness_job_events_do_not_enqueue_legacy_job_callbacks() {
        let (_root, _repo, _state_dir, state) = fixture().await;
        sqlx::query(
            "UPDATE callback_runtime_state SET enabled=1, updated_at=unixepoch() WHERE id=1",
        )
        .execute(&state.db)
        .await
        .expect("enable callback runtime");

        let run = begin_run(&state, "principal-a", "run:callback-isolation").await;
        let created = call(
            &state,
            start_request(&run.run.id, "job:callback-isolation", None),
            "principal-a",
            false,
        )
        .await
        .expect("start Harness job");
        let cancelled = call(
            &state,
            job_request(&run.run.id, HarnessJobOperation::Cancel, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect("cancel Harness job");
        assert_eq!(cancelled.job.status, "cancelled");

        let persisted_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_events WHERE job_id=?1 AND event_type IN ('job_started', 'job_cancelled')",
        )
        .bind(&created.job.id)
        .fetch_one(&state.db)
        .await
        .expect("count Harness job events");
        assert_eq!(persisted_events, 2);

        let legacy_job_callbacks: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM callback_outbox WHERE source_kind='job_event' AND job_id=?1",
        )
        .bind(&created.job.id)
        .fetch_one(&state.db)
        .await
        .expect("count legacy job callbacks");
        assert_eq!(legacy_job_callbacks, 0);
    }

''',
)
