#!/usr/bin/env bash
set -euo pipefail

: "${SOURCENERVE_SMOKE_BASE:?SOURCENERVE_SMOKE_BASE is required}"
: "${SOURCENERVE_SMOKE_TOKEN:?SOURCENERVE_SMOKE_TOKEN is required}"
: "${SOURCENERVE_SMOKE_OUT:?SOURCENERVE_SMOKE_OUT is required}"

BASE="$SOURCENERVE_SMOKE_BASE"
AUTH="Authorization: Bearer $SOURCENERVE_SMOKE_TOKEN"
OUT="$SOURCENERVE_SMOKE_OUT"
mkdir -p "$OUT"

request_get() {
  local label="$1" url="$2" out="$3"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' -H "$AUTH" "$url")
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "[$label] GET $url failed with HTTP $code" >&2
    cat "$out" >&2 || true
    return 1
  fi
  echo "[$label] HTTP $code"
}

request_json() {
  local label="$1" url="$2" data="$3" out="$4"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' \
    -H "$AUTH" -H 'Content-Type: application/json' \
    --data-binary "$data" "$url")
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "[$label] POST $url failed with HTTP $code" >&2
    cat "$out" >&2 || true
    return 1
  fi
  echo "[$label] HTTP $code"
}

request_file() {
  local label="$1" url="$2" file="$3" out="$4"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' \
    -H "$AUTH" -H 'Content-Type: application/json' \
    --data-binary @"$file" "$url")
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "[$label] POST $url failed with HTTP $code" >&2
    cat "$out" >&2 || true
    return 1
  fi
  echo "[$label] HTTP $code"
}

ready=0
for _ in $(seq 1 30); do
  if curl -fsS "$BASE/healthz" > "$OUT/health.json"; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "SourceNerve did not become healthy" >&2
  exit 1
fi

request_get status "$BASE/api/v1/status" "$OUT/status.json"
request_json index "$BASE/api/v1/index" '{"workspace":"smoke"}' "$OUT/index.json"
request_json context "$BASE/api/v1/context/pack" \
  '{"workspace":"smoke","query":"smoke","seed_symbol_keys":[],"max_bytes":4096,"max_items":5,"require_clean":true}' \
  "$OUT/context.json"
request_json begin "$BASE/api/v1/tasks/begin" \
  '{"workspace":"smoke","client_request_id":"smoke:lifecycle","context_query":"smoke","context_max_bytes":4096,"context_max_items":5}' \
  "$OUT/begin.json"

TASK_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"]["id"])' "$OUT/begin.json")
request_json branch "$BASE/api/v1/tasks/lifecycle/branch" \
  "{\"task_id\":\"$TASK_ID\",\"branch\":\"feat/smoke-lifecycle\"}" \
  "$OUT/branch.json"

python3 - "$TASK_ID" "$OUT/context.json" > "$OUT/proposal-request.json" <<'PY'
import json, sys
task_id = sys.argv[1]
context = json.load(open(sys.argv[2]))
sha = context['items'][0]['sha256']
patch = "diff --git a/lib.rs b/lib.rs\n--- a/lib.rs\n+++ b/lib.rs\n@@ -1 +1 @@\n-pub fn smoke() -> bool { true }\n+pub fn smoke() -> bool { false }\n"
print(json.dumps({
    'task_id': task_id,
    'idempotency_key': 'smoke:lifecycle:proposal',
    'expected_files': [{'path': 'lib.rs', 'sha256': sha}],
    'patch': patch,
}))
PY
request_file proposal "$BASE/api/v1/tasks/proposals/create" \
  "$OUT/proposal-request.json" "$OUT/proposal.json"
PROPOSAL_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["proposal"]["id"])' "$OUT/proposal.json")
request_json apply "$BASE/api/v1/tasks/proposals/apply" \
  "{\"task_id\":\"$TASK_ID\",\"proposal_id\":\"$PROPOSAL_ID\"}" \
  "$OUT/apply.json"
request_json review "$BASE/api/v1/tasks/lifecycle/review" \
  "{\"task_id\":\"$TASK_ID\"}" "$OUT/review.json"
request_json commit "$BASE/api/v1/tasks/lifecycle/commit" \
  "{\"task_id\":\"$TASK_ID\",\"message\":\"task lifecycle smoke\"}" \
  "$OUT/commit.json"
request_json push "$BASE/api/v1/tasks/lifecycle/push" \
  "{\"task_id\":\"$TASK_ID\"}" "$OUT/push.json"
request_json get "$BASE/api/v1/tasks/get" \
  "{\"task_id\":\"$TASK_ID\"}" "$OUT/get.json"

python3 - "$OUT/status.json" "$OUT/begin.json" "$OUT/branch.json" "$OUT/review.json" "$OUT/commit.json" "$OUT/push.json" "$OUT/get.json" <<'PY'
import json, sys
status, begin, branch, review, commit, push, current = [json.load(open(p)) for p in sys.argv[1:]]
assert status['identity']['state_schema_version'] == 11, status
assert 'task-git-pr-lifecycle' in status['identity']['capabilities'], status
assert 'durable-outbound-callbacks' in status['identity']['capabilities'], status
assert 'semantic-vector-enrichment' in status['identity']['capabilities'], status
assert begin['task']['status'] == 'active', begin
assert branch['lifecycle']['phase'] == 'branched', branch
assert review['lifecycle']['phase'] == 'reviewed', review
assert review['lifecycle']['reviewed_diff_sha256'] == review['review']['diff_sha256'], review
assert commit['lifecycle']['phase'] == 'committed', commit
assert commit['lifecycle']['commit_sha'] == commit['commit']['commit'], commit
assert push['lifecycle']['phase'] == 'pushed', push
assert push['lifecycle']['push_sha'] == push['push']['head'], push
assert current['task']['status'] == 'applied', current
assert current['lifecycle']['phase'] == 'pushed', current
assert current['lifecycle']['push_sha'] == push['push']['head'], (current, push)
assert current['github_observation'] is None, current
assert all('patch' not in event['metadata'] for event in current['events']), current
PY
