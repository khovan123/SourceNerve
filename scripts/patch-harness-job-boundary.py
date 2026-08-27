from pathlib import Path

path = Path("src/harness_tool_pipeline.rs")
text = path.read_text()
old = '''    let Some(arguments) = request.arguments.as_ref() else {
        return Ok(None);
    };
    if let Some(workspace) = arguments
'''
new = '''    let Some(arguments) = request.arguments.as_ref() else {
        return Ok(None);
    };
    if request.name.as_ref() == "harness_job_call" {
        if let Some(run_id) = arguments
            .get("run_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Ok(sqlx::query_scalar::<_, String>(
                "SELECT workspace_id FROM harness_runs WHERE id=?1",
            )
            .bind(run_id)
            .fetch_optional(&state.db)
            .await?);
        }
        return Ok(None);
    }
    if let Some(workspace) = arguments
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one request_workspace insertion point, found {text.count(old)}")
text = text.replace(old, new, 1)

marker = '''    #[test]
    fn unknown_tools_are_conservative_and_not_explicitly_classified() {
'''
test = '''    #[test]
    fn harness_job_workspace_resolution_is_run_authoritative() {
        let mut request = CallToolRequestParams::new("harness_job_call".to_string());
        request.arguments = Some(serde_json::Map::from_iter([
            (
                "run_id".to_string(),
                serde_json::Value::String("run-1".to_string()),
            ),
            (
                "job_id".to_string(),
                serde_json::Value::String("foreign-job".to_string()),
            ),
        ]));
        assert_eq!(request_run_id(&request).as_deref(), Some("run-1"));
    }

'''
if text.count(marker) != 1:
    raise SystemExit(f"expected one test insertion point, found {text.count(marker)}")
text = text.replace(marker, test + marker, 1)
path.write_text(text)
