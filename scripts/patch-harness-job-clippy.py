from pathlib import Path

path = Path("src/harness_job.rs")
text = path.read_text()
old = '''    run_id: String,
    principal_id: String,
    harness_request_id: Option<String>,
    kind: String,
'''
new = '''    run_id: String,
    kind: String,
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one HarnessJobRow field block, found {text.count(old)}")
text = text.replace(old, new, 1)
old = '''        run_id: row.4,
        principal_id: row.5,
        harness_request_id: row.6,
        kind: row.7,
'''
new = '''        run_id: row.4,
        kind: row.7,
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one from_db ownership field block, found {text.count(old)}")
text = text.replace(old, new, 1)
path.write_text(text)
